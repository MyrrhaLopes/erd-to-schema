/**
 * Teste de carga (fase 6): N clientes no mesmo canvas de ~200 tabelas, editando ao mesmo
 * tempo pelo WebSocket de colaboração, como navegadores fariam.
 *
 *   URL=http://localhost:8081 CLIENTS=20 TABLES=200 SECONDS=60 pnpm --filter @erd/e2e load
 *
 * Mede a latência de propagação (cada cliente carimba um "ping" no documento e os outros
 * medem quando ele chega), confere que todos convergem para o mesmo documento no fim e,
 * se `METRICS_URL` estiver definido, imprime as métricas do servidor. Os clientes rodam em
 * vários processos (`PROCS`, padrão: um por núcleo): 20 "navegadores" num processo só
 * fariam do próprio gerador o gargalo.
 *
 * Conta: `LOAD_EMAIL` + `LOAD_PASSWORD` de uma conta existente, ou cria uma nova e confirma
 * o e-mail pelo Mailpit (`MAILPIT_URL`, padrão http://localhost:8025) — no staging, use uma
 * conta de teste já verificada.
 */
import * as Y from 'yjs';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { applyDiff, emptyProjectDoc, fromProject, LOCAL_ORIGIN, projectDoc, roots, type ProjectDoc } from '@erd/crdt';
import type { Table } from '@erd/model/types';

const URL_ = process.env.URL ?? 'http://localhost:8081';
const CLIENTS = Number(process.env.CLIENTS ?? 20);
const TABLES = Number(process.env.TABLES ?? 200);
const SECONDS = Number(process.env.SECONDS ?? 60);
const OPS_PER_SECOND = Number(process.env.OPS_PER_SECOND ?? 2);
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/* --------------------------- HTTP com cookies --------------------------- */

const jar = new Map<string, string>();
async function http(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set('origin', URL_);
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const r = await fetch(path.startsWith('http') ? path : URL_ + path, { ...init, headers, body, redirect: 'manual' });
  for (const sc of r.headers.getSetCookie()) {
    const [kv] = sc.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return r;
}

async function login() {
  const password = process.env.LOAD_PASSWORD ?? 'senha-forte-123';
  let email = process.env.LOAD_EMAIL;
  if (!email) {
    email = `carga.${Date.now().toString(36)}@load.test`;
    const r = await http('/api/auth/sign-up/email', { method: 'POST', json: { name: 'Carga', email, password } });
    if (!r.ok) throw new Error(`cadastro: ${r.status} ${await r.text()}`);
    let link: string | undefined;
    for (let i = 0; i < 60 && !link; i++) {
      const s = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { ID: string }[] };
      if (s.messages[0]) {
        const m = (await (await fetch(`${MAILPIT}/api/v1/message/${s.messages[0].ID}`)).json()) as { Text: string };
        link = m.Text.match(/https?:\/\/\S*verify-email\S*/)?.[0];
      } else await new Promise((res) => setTimeout(res, 250));
    }
    if (!link) throw new Error('e-mail de verificação não chegou (MAILPIT_URL?)');
    await http(link.replace(/^https?:\/\/[^/]+/, ''));
  }
  const r = await http('/api/auth/sign-in/email', { method: 'POST', json: { email, password } });
  if (!r.ok) throw new Error(`login: ${r.status} ${await r.text()}`);
}

/* ----------------------------- documento ----------------------------- */

function bigProject(n: number): ProjectDoc {
  const p = emptyProjectDoc(`Carga ${n} tabelas`);
  const tables: Table[] = [];
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    tables.push({
      id,
      name: `tabela_${i}`,
      columns: [
        { id: `${id}_id`, name: 'id', type: { base: 'bigint' }, nullable: false, identity: 'by-default' },
        { id: `${id}_nome`, name: 'nome', type: { base: 'text' }, nullable: false },
        { id: `${id}_criado`, name: 'criado_em', type: { base: 'timestamptz' }, nullable: false, default: 'now()' },
        ...(i > 0 ? [{ id: `${id}_pai`, name: 'pai_id', type: { base: 'bigint' }, nullable: true }] : []),
      ],
      primaryKey: [`${id}_id`],
      uniques: [],
      indexes: [],
      checks: [],
    });
    p.layout[id] = { x: (i % 20) * 300, y: Math.floor(i / 20) * 220 };
    if (i > 0)
      p.schema.relationships.push({ id: `r${i}`, kind: 'fk', fromTable: id, fromColumns: [`${id}_pai`], toTable: `t${Math.floor(i / 2)}`, toColumns: [`t${Math.floor(i / 2)}_id`] });
  }
  p.schema.tables = tables;
  return p;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

/* -------------------------------- main -------------------------------- */

/** Relógio comum entre os processos (mesma máquina) */
const clock = () => performance.timeOrigin + performance.now();

type Report = { latencies: number[]; syncTimes: number[]; ops: number; errors: number; loopP99: number };
type Final = { svs: string[]; models: string[]; unsynced: number };
type FromChild = { type: 'ready' } | { type: 'done'; report: Report } | { type: 'final'; final: Final };
type ToChild = { type: 'go'; end: number } | { type: 'final' };

/** Processo filho: `count` clientes a partir de `first` */
async function child() {
  const { CANVAS, COOKIE, FIRST, COUNT } = process.env as Record<string, string>;
  for (const kv of JSON.parse(COOKIE) as [string, string][]) jar.set(kv[0], kv[1]);
  const send = (m: FromChild) => process.send!(m);
  const ws = URL_.replace(/^http/, 'ws') + '/collab';
  const report: Report = { latencies: [], syncTimes: [], ops: 0, errors: 0, loopP99: 0 };
  const clients = await Promise.all(
    Array.from({ length: Number(COUNT) }, async (_, k) => {
      const i = Number(FIRST) + k;
      const doc = new Y.Doc();
      const t0 = clock();
      const provider = new HocuspocusProvider({
        url: ws,
        name: `canvas:${CANVAS}`,
        document: doc,
        token: async () => {
          const t = await http(`/api/canvases/${CANVAS}/collab-token`, { method: 'POST' });
          return ((await t.json()) as { token: string }).token;
        },
        onAuthenticationFailed: ({ reason }) => {
          report.errors++;
          console.error(`cliente ${i}: autenticação falhou: ${reason}`);
        },
      });
      await new Promise<void>((res) => provider.on('synced', () => res()));
      report.syncTimes.push(clock() - t0);
      roots(doc).meta.observe((e) => {
        if (e.transaction.local) return;
        for (const key of e.keysChanged) {
          if (!key.startsWith('ping:') || key === `ping:${i}`) continue;
          const ts = roots(doc).meta.get(key) as number | undefined;
          if (ts) report.latencies.push(clock() - ts);
        }
      });
      return { i, doc, provider };
    }),
  );
  send({ type: 'ready' });
  process.on('message', async (m: ToChild) => {
    if (m.type === 'final') {
      send({
        type: 'final',
        final: {
          svs: clients.map((c) => Buffer.from(Y.encodeStateVector(c.doc)).toString('base64')),
          models: clients.map((c) => createHash('sha1').update(JSON.stringify(projectDoc(c.doc))).digest('hex')),
          unsynced: clients.filter((c) => c.provider.unsyncedChanges > 0).length,
        },
      });
      return;
    }
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    await Promise.all(
      clients.map(async ({ i, doc }) => {
        let n = 0;
        while (Date.now() < m.end) {
          await new Promise((res) => setTimeout(res, (1000 / OPS_PER_SECOND) * (0.5 + Math.random())));
          try {
            const before = projectDoc(doc);
            const t = before.schema.tables[Math.floor(Math.random() * before.schema.tables.length)];
            const op = n++ % 10;
            doc.transact(() => {
              if (op === 9) {
                // de vez em quando, digita no painel SQL (o sync bot traduz no servidor)
                const sql = doc.getText('code:sql');
                sql.insert(sql.length, `\n-- cliente ${i} passou por aqui (${n})\n`);
              } else if (op % 3 === 0) {
                applyDiff(doc, before, { ...before, layout: { ...before.layout, [t.id]: { ...before.layout[t.id], x: Math.round(Math.random() * 6000), y: Math.round(Math.random() * 2400) } } });
              } else {
                const tables = before.schema.tables.map((x) => (x.id === t.id ? { ...x, columns: x.columns.map((c) => (c.name === 'nome' || c.name.startsWith('nome_') ? { ...c, name: `nome_${i}_${n}` } : c)) } : x));
                applyDiff(doc, before, { ...before, schema: { ...before.schema, tables } });
              }
              roots(doc).meta.set(`ping:${i}`, clock());
            }, LOCAL_ORIGIN);
            report.ops++;
          } catch (e) {
            report.errors++;
            console.error(`cliente ${i}:`, (e as Error).message);
          }
        }
      }),
    );
    loop.disable();
    report.loopP99 = Math.round(loop.percentile(99) / 1e6);
    send({ type: 'done', report });
  });
}

async function main() {
  const procs = Math.max(1, Math.min(CLIENTS, Number(process.env.PROCS ?? availableParallelism())));
  console.log(`carga: ${CLIENTS} clientes em ${procs} processo(s), ${TABLES} tabelas, ${SECONDS} s, ~${OPS_PER_SECOND} op/s por cliente → ${URL_}`);
  await login();
  const initialState = Buffer.from(fromProject(bigProject(TABLES))).toString('base64');
  const r = await http('/api/projects', { method: 'POST', json: { name: `Carga ${new Date().toISOString()}`, template: 'empty', initialState } });
  if (!r.ok) throw new Error(`criar projeto: ${r.status} ${await r.text()}`);
  const { canvasId } = (await r.json()) as { canvasId: string };
  console.log(`canvas ${canvasId} criado`);

  const children = Array.from({ length: procs }, (_, p) => {
    const first = Math.floor((p * CLIENTS) / procs);
    const count = Math.floor(((p + 1) * CLIENTS) / procs) - first;
    return fork(process.argv[1], [], {
      execArgv: process.execArgv,
      env: { ...process.env, LOAD_ROLE: 'child', CANVAS: canvasId, COOKIE: JSON.stringify([...jar]), FIRST: String(first), COUNT: String(count) },
    });
  });
  const next = <T extends FromChild['type']>(type: T) =>
    Promise.all(children.map((c) => new Promise<Extract<FromChild, { type: T }>>((res) => c.once('message', (m: FromChild) => m.type === type && res(m as Extract<FromChild, { type: T }>)))));
  await next('ready');
  const done = next('done');
  for (const c of children) c.send({ type: 'go', end: Date.now() + SECONDS * 1000 } satisfies ToChild);
  const reports = (await done).map((m) => m.report);
  const all = { latencies: reports.flatMap((x) => x.latencies), syncTimes: reports.flatMap((x) => x.syncTimes), ops: reports.reduce((a, x) => a + x.ops, 0), errors: reports.reduce((a, x) => a + x.errors, 0) };
  console.log(`todos sincronizados: carga inicial p50 ${pct(all.syncTimes, 50)} ms, p95 ${pct(all.syncTimes, 95)} ms`);

  // convergência: todos com o mesmo vetor de estado e o mesmo modelo
  let converged = false;
  let finals: Final[] = [];
  for (let k = 0; k < 30 && !converged; k++) {
    await new Promise((res) => setTimeout(res, 1000));
    const got = next('final');
    for (const c of children) c.send({ type: 'final' } satisfies ToChild);
    finals = (await got).map((m) => m.final);
    const svs = finals.flatMap((f) => f.svs);
    const models = finals.flatMap((f) => f.models);
    converged = finals.every((f) => f.unsynced === 0) && svs.every((x) => x === svs[0]) && models.every((x) => x === models[0]);
  }
  for (const c of children) c.kill();

  console.log('\n--- resultado ---');
  console.log(`operações: ${all.ops} (${(all.ops / SECONDS).toFixed(1)}/s no total), erros: ${all.errors}`);
  console.log(`latência de propagação: p50 ${pct(all.latencies, 50)} ms, p95 ${pct(all.latencies, 95)} ms, p99 ${pct(all.latencies, 99)} ms, máx ${pct(all.latencies, 100)} ms (${all.latencies.length} amostras)`);
  console.log(`atraso do event loop dos geradores: p99 ${Math.max(...reports.map((x) => x.loopP99))} ms`);
  console.log(`convergência: ${converged ? 'OK — todos com o mesmo documento' : 'FALHOU'}`);
  if (process.env.METRICS_URL) {
    const m = await fetch(process.env.METRICS_URL, { headers: process.env.METRICS_TOKEN ? { authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {} });
    console.log('\n--- /metrics ---\n' + (await m.text()).split('\n').filter((l) => l && !l.startsWith('#')).join('\n'));
  }
  const ok = converged && all.errors === 0 && pct(all.latencies, 95) < Number(process.env.MAX_P95_MS ?? 1000);
  process.exit(ok ? 0 : 1);
}

(process.env.LOAD_ROLE === 'child' ? child() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
