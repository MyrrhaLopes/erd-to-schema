import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import { serve } from '@hono/node-server';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { applyDiff, codeText, LOCAL_ORIGIN, projectDoc, type ProjectDoc } from '@erd/crdt';
import { projectMembers } from '@erd/db';
import { createApp } from '../src/app';
import { createDeps, wirePermissionEvents } from '../src/deps';
import { createLogger } from '../src/log';
import type { Deps } from '../src/context';
import { harness } from './harness';

/**
 * Fase 7: duas réplicas do `server` (cada uma com API + collab) sobre o mesmo Postgres e o
 * mesmo Redis. Ana conecta na réplica A, Bruno na B. Roda com TEST_REDIS_URL definido
 * (no CI, o serviço redis; local, `docker run -p 6379:6379 redis:7-alpine`).
 */
const REDIS = process.env.TEST_REDIS_URL;

let h: Awaited<ReturnType<typeof harness>>;
let a: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['listen']>>;
let depsB: Deps;
let wsB = '';
let closeB: () => Promise<void> = async () => {};
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
  if (!REDIS) return;
  h = await harness({ realtime: true, envOverrides: { REDIS_URL: REDIS } });
  a = await h.listen();
  // réplica B: mesmo banco, mesmo Redis, outro processo lógico
  depsB = createDeps(h.env, { db: h.db, pool: h.pool, mailer: h.mailer, log: createLogger('silent') });
  const app = createApp(depsB);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as unknown as import('node:http').Server));
  });
  depsB.collab!.attach(server);
  const unlisten = await wirePermissionEvents(depsB);
  wsB = `ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/collab`;
  closeB = async () => {
    await unlisten();
    await depsB.collab!.shutdown();
    await new Promise((r) => server.close(r));
    await depsB.redis?.quit();
  };
});
afterAll(async () => {
  for (const p of providers) p.destroy();
  await closeB();
  await a?.close();
  await h?.deps.redis?.quit();
  await h?.close();
});

const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condição não satisfeita a tempo');
};

async function connect(b: Awaited<ReturnType<typeof h.signup>>, canvasId: string, url: string) {
  const doc = new Y.Doc();
  const stateless: string[] = [];
  const provider = new HocuspocusProvider({
    url,
    name: `canvas:${canvasId}`,
    document: doc,
    token: async () => (await b.json<{ token: string }>(`/api/canvases/${canvasId}/collab-token`, { method: 'POST' })).body.token,
    onStateless: ({ payload }) => stateless.push(payload),
  });
  providers.push(provider);
  await until(() => provider.isSynced);
  return { doc, provider, stateless };
}

function commit(doc: Y.Doc, recipe: (d: ProjectDoc) => void) {
  const before = projectDoc(doc);
  doc.transact(() => applyDiff(doc, before, produce(before, recipe)), LOCAL_ORIGIN);
}

describe.skipIf(!REDIS)('várias réplicas (Redis)', () => {
  it('Ana na réplica A e Bruno na B se veem; o SQL do Bruno é traduzido uma vez só; o papel muda ao vivo entre réplicas', async () => {
    const ana = await h.signup('Ana');
    const bruno = await h.signup('Bruno');
    const p = await ana.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Escala', template: 'sample' } });
    await h.db.insert(projectMembers).values({ projectId: p.body.id, userId: bruno.id, role: 'editor', color: 1 });
    const A = await connect(ana, p.body.canvasId, a.ws);
    const B = await connect(bruno, p.body.canvasId, wsB);

    // edição no canvas: A → B
    commit(A.doc, (d) => void (d.schema.tables[0].name = 'clientes'));
    await until(() => projectDoc(B.doc).schema.tables[0].name === 'clientes');

    // SQL digitado na B: só um bot (o líder) traduz, sem entidades em dobro
    const sql = codeText(B.doc, 'sql');
    sql.insert(sql.length, '\nCREATE TABLE auditoria (\n  id serial PRIMARY KEY,\n  evento text NOT NULL\n);\n');
    await until(() => projectDoc(A.doc).schema.tables.some((t) => t.name === 'auditoria'), 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    for (const d of [A.doc, B.doc]) {
      expect(projectDoc(d).schema.tables.filter((t) => t.name === 'auditoria')).toHaveLength(1);
      expect(codeText(d, 'sql').toString().match(/CREATE TABLE auditoria/g)).toHaveLength(1);
      expect(codeText(d, 'prisma').toString().match(/model auditoria \{/gi)).toHaveLength(1);
    }
    expect(Number(!!h.deps.collab!.bots.size) + Number(!!depsB.collab!.bots.size)).toBe(1);

    // mudança de papel publicada pela API da réplica A chega à conexão do Bruno na B
    await ana.json(`/api/projects/${p.body.id}/members/${bruno.id}`, { method: 'PATCH', json: { role: 'viewer' } });
    await until(() => B.stateless.some((s) => s.includes('"permission-changed"') && s.includes('viewer')));
  });

  it('a escrita da API (import) na réplica B chega ao documento aberto na A', async () => {
    const ana = await h.signup('Carla');
    const p = await ana.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Import', template: 'sample' } });
    const A = await connect(ana, p.body.canvasId, a.ws);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(A.doc));
    const sv = Y.encodeStateVector(doc);
    commit(doc, (d) => void (d.notes[0].title = 'Importada pela B'));
    await depsB.writer.apply(p.body.canvasId, Y.encodeStateAsUpdate(doc, sv));
    await until(() => projectDoc(A.doc).notes[0].title === 'Importada pela B');
  });
});
