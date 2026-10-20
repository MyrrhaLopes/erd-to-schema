import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { applyDiff, codeText, LOCAL_ORIGIN, projectDoc, type ProjectDoc } from '@erd/crdt';
import { projectMembers } from '@erd/db';
import { readSync } from '@erd/sync';
import { harness } from './harness';

let h: Awaited<ReturnType<typeof harness>>;
let srv: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['listen']>>;
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
  h = await harness({ realtime: true });
  srv = await h.listen();
});
afterAll(async () => {
  for (const p of providers) p.destroy();
  await srv?.close();
  await h?.close();
});

type Browser = Awaited<ReturnType<typeof h.signup>>;

async function connect(b: Browser, canvasId: string, opts: { token?: () => Promise<string> } = {}) {
  const doc = new Y.Doc();
  const events: { stateless: string[]; authFailed: string[] } = { stateless: [], authFailed: [] };
  const provider = new HocuspocusProvider({
    url: srv.ws,
    name: `canvas:${canvasId}`,
    document: doc,
    token:
      opts.token ??
      (async () => {
        const r = await b.json<{ token: string }>(`/api/canvases/${canvasId}/collab-token`, { method: 'POST' });
        return r.body.token;
      }),
    onStateless: ({ payload }) => events.stateless.push(payload),
    onAuthenticationFailed: ({ reason }) => events.authFailed.push(reason),
  });
  providers.push(provider);
  return { doc, provider, events };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condição não satisfeita a tempo');
};

const synced = (p: HocuspocusProvider) => until(() => p.isSynced);

function commit(doc: Y.Doc, recipe: (d: ProjectDoc) => void) {
  const before = projectDoc(doc);
  doc.transact(() => applyDiff(doc, before, produce(before, recipe)), LOCAL_ORIGIN);
}

async function setup() {
  const ana = await h.signup(`Ana${Date.now() % 100000}`);
  const bruno = await h.signup(`Bruno${Date.now() % 100000}`);
  const p = await ana.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Loja', template: 'sample' } });
  await h.db.insert(projectMembers).values({ projectId: p.body.id, userId: bruno.id, role: 'editor', color: 1 });
  return { ana, bruno, projectId: p.body.id, canvasId: p.body.canvasId };
}

describe('tempo real', () => {
  it('uma tabela criada em A aparece em B em menos de 1 s', async () => {
    const { ana, bruno, canvasId } = await setup();
    const a = await connect(ana, canvasId);
    const b = await connect(bruno, canvasId);
    await synced(a.provider);
    await synced(b.provider);
    expect(projectDoc(b.doc).schema.tables.map((t) => t.name)).toContain('customers');
    const t0 = Date.now();
    commit(a.doc, (d) => {
      d.schema.tables.push({ id: 't_rt', name: 'fornecedores', columns: [], primaryKey: [], uniques: [], indexes: [], checks: [] });
      d.layout.t_rt = { x: 0, y: 0 };
    });
    await until(() => projectDoc(b.doc).schema.tables.some((t) => t.name === 'fornecedores'), 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('A e B digitam no mesmo painel SQL: o bot do servidor traduz, sem duplicar, e os outros painéis acompanham', async () => {
    const { ana, bruno, canvasId } = await setup();
    const a = await connect(ana, canvasId);
    const b = await connect(bruno, canvasId);
    await synced(a.provider);
    await synced(b.provider);
    // o servidor gerou os textos na primeira carga
    await until(() => codeText(a.doc, 'sql').toString().includes('CREATE TABLE customers'));
    const ta = codeText(a.doc, 'sql');
    const tb = codeText(b.doc, 'sql');
    ta.insert(0, 'CREATE TABLE tags (\n  id serial PRIMARY KEY\n);\n\n');
    tb.insert(tb.length, '\nCREATE TABLE logs (\n  id serial PRIMARY KEY,\n  msg text\n);\n');
    await until(() => {
      const names = projectDoc(a.doc).schema.tables.map((t) => t.name);
      return names.includes('tags') && names.includes('logs');
    }, 8000);
    await until(() => codeText(b.doc, 'prisma').toString().includes('model Log {'), 5000);
    const names = projectDoc(b.doc).schema.tables.map((t) => t.name);
    expect(names.filter((n) => n === 'tags')).toHaveLength(1);
    expect(names.filter((n) => n === 'logs')).toHaveLength(1);
    expect(codeText(a.doc, 'drizzle').toString()).toContain("pgTable('tags'");
    // autoria: o servidor mapeou os clientIDs para os usuários
    await until(() => Y.encodeStateVector(a.doc) && projectDoc(a.doc).schema.tables.find((t) => t.name === 'logs') !== undefined);
    expect(readSync(a.doc, 'sql')?.status).toBe('synced');
  });

  it('o Drizzle é traduzido no servidor, dentro do sandbox', async () => {
    const { ana, canvasId } = await setup();
    const a = await connect(ana, canvasId);
    await synced(a.provider);
    await until(() => codeText(a.doc, 'drizzle').toString().includes('pgTable('));
    const t = codeText(a.doc, 'drizzle');
    t.insert(t.length, "\nexport const audit = pgTable('audit', { id: serial().primaryKey() });\n");
    a.provider.sendStateless(JSON.stringify({ type: 'flush', format: 'drizzle' }));
    await until(() => projectDoc(a.doc).schema.tables.some((x) => x.name === 'audit'), 8000);
    expect(codeText(a.doc, 'sql').toString()).toContain('CREATE TABLE audit');
  });

  it('o viewer não altera o documento, um token de outro canvas é recusado, e mudar o papel vale ao vivo', async () => {
    const { ana, bruno, projectId, canvasId } = await setup();
    const other = await ana.json<{ canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Outro' } });
    // token de outro canvas
    const wrong = await connect(ana, canvasId, {
      token: async () => (await ana.json<{ token: string }>(`/api/canvases/${other.body.canvasId}/collab-token`, { method: 'POST' })).body.token,
    });
    await until(() => wrong.events.authFailed.length > 0);
    wrong.provider.destroy();

    const a = await connect(ana, canvasId);
    await synced(a.provider);
    // Bruno vira viewer: suas edições são descartadas pelo servidor
    await h.deps.events.permissionChanged({ projectId, userId: bruno.id, role: 'viewer' });
    const { eq, and } = await import('@erd/db');
    await h.db.update(projectMembers).set({ role: 'viewer' }).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, bruno.id)));
    const b = await connect(bruno, canvasId);
    await synced(b.provider);
    commit(b.doc, (d) => void (d.schema.tables[0].name = 'hackeado'));
    await new Promise((r) => setTimeout(r, 400));
    expect(projectDoc(a.doc).schema.tables[0].name).not.toBe('hackeado');

    // promovido a editor: a conexão aberta recebe o aviso (o cliente reconecta com token novo)
    await h.db.update(projectMembers).set({ role: 'editor' }).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, bruno.id)));
    await h.deps.events.permissionChanged({ projectId, userId: bruno.id, role: 'editor' });
    await until(() => b.events.stateless.some((s) => s.includes('"permission-changed"') && s.includes('editor')));
  });

  it('desligar o link de visualização derruba quem entrou só pelo link; aprovar um pedido avisa a conexão aberta', async () => {
    const { ana, projectId, canvasId } = await setup();
    const curioso = await h.signup(`Curioso${Date.now() % 100000}`);
    await ana.json(`/api/projects/${projectId}`, { method: 'PATCH', json: { settings: { linkSharing: 'view' } } });
    const c = await connect(curioso, canvasId);
    await synced(c.provider);
    // pede edição e é aprovado: o aviso chega pela conexão aberta
    const r = await curioso.json<{ id: string }>(`/api/projects/${projectId}/access-requests`, { method: 'POST', json: {} });
    await ana.json(`/api/access-requests/${r.body.id}/approve`, { method: 'POST' });
    await until(() => c.events.stateless.some((s) => s.includes('"permission-changed"') && s.includes('editor')));

    const outro = await h.signup(`Outro${Date.now() % 100000}`);
    const o = await connect(outro, canvasId);
    await synced(o.provider);
    await ana.json(`/api/projects/${projectId}`, { method: 'PATCH', json: { settings: { linkSharing: 'off' } } });
    await until(() => o.events.stateless.some((s) => s.includes('"permission-changed"') && s.includes('null')));
    // o membro aprovado continua
    expect(c.events.stateless.some((s) => s.includes('null'))).toBe(false);
  });

  it('a compactação e o descarregamento preservam o estado', async () => {
    const { ana, canvasId } = await setup();
    const a = await connect(ana, canvasId);
    await synced(a.provider);
    for (let i = 0; i < 5; i++) commit(a.doc, (d) => void (d.notes[0].content += ` ${i}`));
    const expected = projectDoc(a.doc).notes[0].content;
    a.provider.destroy();
    // o documento é gravado e descarregado quando a última conexão sai
    await until(() => !h.deps.collab!.hocuspocus.documents.has(`canvas:${canvasId}`), 15000);
    await h.deps.store.compact(canvasId);
    const state = new Uint8Array(await (await ana.req(`/api/canvases/${canvasId}/state`)).arrayBuffer());
    const d = new Y.Doc();
    Y.applyUpdate(d, state);
    expect(projectDoc(d).notes[0].content).toBe(expected);
  });
});
