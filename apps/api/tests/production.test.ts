import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import { applyDiff, LOCAL_ORIGIN, projectDoc } from '@erd/crdt';
import { canvasVersions, eq } from '@erd/db';
import type { ProjectSummary, Version } from '@erd/contracts';
import { harness } from './harness';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness({ envOverrides: { MAX_PROJECTS_PER_USER: '3', MAX_CANVASES_PER_PROJECT: '2', MAX_MEMBERS_PER_PROJECT: '2', API_RATE_PER_MINUTE: '400', METRICS_TOKEN: 'segredo-das-metricas' } });
});
afterAll(() => h?.close());

type B = Awaited<ReturnType<typeof h.signup>>;

async function stateOf(b: B, canvasId: string) {
  const r = await b.req(`/api/canvases/${canvasId}/state`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await r.arrayBuffer()));
  return doc;
}

/** Faz uma edição como um cliente faria (update Yjs pela API) */
async function edit(b: B, canvasId: string, recipe: (d: ReturnType<typeof projectDoc>) => void) {
  const doc = await stateOf(b, canvasId);
  const sv = Y.encodeStateVector(doc);
  const before = projectDoc(doc);
  doc.transact(() => applyDiff(doc, before, produce(before, recipe)), LOCAL_ORIGIN);
  const r = await b.json(`/api/canvases/${canvasId}/updates`, { method: 'POST', body: Y.encodeStateAsUpdate(doc, sv) as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
  expect(r.status).toBe(200);
}

describe('versões', () => {
  it('salvar, listar, baixar o estado de uma versão, registrar a restauração e apagar', async () => {
    const ana = await h.signup('Ana');
    const p = await ana.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Loja', template: 'sample' } });
    const c = p.body.canvasId;
    const v1 = await ana.json<{ id: string }>(`/api/canvases/${c}/versions`, { method: 'POST', json: { label: 'antes' } });
    expect(v1.status).toBe(201);
    await edit(ana, c, (d) => void (d.schema.tables[0].name = 'clientes'));
    const list = await ana.json<Version[]>(`/api/canvases/${c}/versions`);
    expect(list.body.map((v) => [v.label, v.createdBy?.name])).toEqual([['antes', 'Ana']]);
    // o estado da versão é o de antes da edição
    const r = await ana.req(`/api/canvases/${c}/versions/${v1.body.id}/state`);
    const vdoc = new Y.Doc();
    Y.applyUpdate(vdoc, new Uint8Array(await r.arrayBuffer()));
    expect(projectDoc(vdoc).schema.tables[0].name).toBe('customers');
    expect(projectDoc(await stateOf(ana, c)).schema.tables[0].name).toBe('clientes');
    expect((await ana.json(`/api/canvases/${c}/versions/${v1.body.id}/restored`, { method: 'POST' })).status).toBe(200);
    // leitor vê mas não salva nem restaura
    const leo = await h.signup('Leo');
    await ana.json(`/api/projects/${p.body.id}/members`, { method: 'POST', json: { email: leo.email, role: 'viewer' } });
    expect((await leo.json(`/api/canvases/${c}/versions`)).status).toBe(200);
    expect((await leo.json(`/api/canvases/${c}/versions`, { method: 'POST', json: { label: 'x' } })).status).toBe(403);
    expect((await leo.json(`/api/canvases/${c}/versions/${v1.body.id}/restored`, { method: 'POST' })).status).toBe(403);
    expect((await leo.json(`/api/canvases/${c}/versions/${v1.body.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await ana.json(`/api/canvases/${c}/versions/${v1.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await ana.json<Version[]>(`/api/canvases/${c}/versions`)).body).toEqual([]);
  });

  it('snapshot automático: no máximo um por dia; os automáticos com mais de 30 dias são apagados', async () => {
    const ana = await h.signup('Bea');
    const p = await ana.json<{ canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Auto' } });
    const c = p.body.canvasId;
    const doc = (await h.deps.store.loadDoc(c))!;
    const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12));
    expect(await h.deps.store.maybeDailyVersion(c, doc, day(1))).toBe(true);
    expect(await h.deps.store.maybeDailyVersion(c, doc, day(1))).toBe(false);
    // createdAt é o relógio do banco: envelhece a primeira para simular o tempo
    await h.db.update(canvasVersions).set({ createdAt: day(1) }).where(eq(canvasVersions.canvasId, c));
    expect(await h.deps.store.maybeDailyVersion(c, doc, day(2))).toBe(true);
    expect(await h.deps.store.maybeDailyVersion(c, doc, day(40))).toBe(false);
    await h.db.update(canvasVersions).set({ createdAt: day(2) }).where(eq(canvasVersions.label, 'Automática — 02/01/2026'));
    expect(await h.deps.store.maybeDailyVersion(c, doc, day(40))).toBe(true);
    const list = await ana.json<Version[]>(`/api/canvases/${c}/versions`);
    expect(list.body.map((v) => v.label)).toEqual(['Automática — 09/02/2026']);
    expect(list.body[0].createdBy).toBeNull();
  });
});

describe('limites e taxas', () => {
  it('projetos por conta, canvases por projeto e membros por projeto', async () => {
    const ana = await h.signup('Cris');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await ana.json<{ id: string }>('/api/projects', { method: 'POST', json: { name: `P${i}` } })).body.id);
    const over = await ana.json<{ error: string }>('/api/projects', { method: 'POST', json: { name: 'P3' } });
    expect(over.status).toBe(422);
    expect(over.body.error).toContain('Limite de 3 projetos');
    expect((await ana.json(`/api/projects/${ids[0]}/canvases`, { method: 'POST', json: { kind: 'erd', name: 'Outro' } })).status).toBe(201);
    expect((await ana.json(`/api/projects/${ids[0]}/canvases`, { method: 'POST', json: { kind: 'erd', name: 'Mais um' } })).status).toBe(422);
    const m1 = await h.signup('Davi');
    await h.signup('Eli');
    expect((await ana.json(`/api/projects/${ids[0]}/members`, { method: 'POST', json: { email: m1.email, role: 'viewer' } })).status).toBe(201);
    expect((await ana.json(`/api/projects/${ids[0]}/members`, { method: 'POST', json: { email: 'eli@x.com', role: 'viewer' } })).status).toBe(422);
  });

  it('limite de requisições por minuto (429 com Retry-After)', async () => {
    const ana = await h.signup('Fabi');
    let last = 0;
    let retry: string | null = null;
    for (let i = 0; i < 405; i++) {
      const r = await ana.req('/api/projects');
      last = r.status;
      retry = r.headers.get('retry-after');
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });
});

describe('observabilidade e miniatura', () => {
  it('/metrics exige o token e expõe as métricas no formato do Prometheus', async () => {
    expect((await h.app.request('/metrics')).status).toBe(401);
    const r = await h.app.request('/metrics', { headers: { authorization: 'Bearer segredo-das-metricas' } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toMatch(/^# TYPE erd_http_requests_total counter$/m);
    expect(text).toMatch(/^erd_pg_pool_total \d+$/m);
  });

  it('miniatura SVG do primeiro canvas, com um retângulo por tabela', async () => {
    const ana = await h.signup('Gabi');
    const p = await ana.json<{ id: string }>('/api/projects', { method: 'POST', json: { name: 'Thumb', template: 'sample' } });
    const list = await ana.json<ProjectSummary[]>('/api/projects');
    expect(list.body[0].thumbnailUrl).toMatch(new RegExp(`^/api/projects/${p.body.id}/thumbnail\\.svg\\?v=\\d+$`));
    const r = await ana.req(list.body[0].thumbnailUrl!);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    const svg = await r.text();
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThan(10);
    expect((await h.browser().req(list.body[0].thumbnailUrl!)).status).toBe(401);
  });
});
