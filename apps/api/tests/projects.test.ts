import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import { unzipSync, strFromU8 } from 'fflate';
import { applyDiff, emptyProjectDoc, fromProject, LOCAL_ORIGIN, projectDoc } from '@erd/crdt';
import type { ProjectDetail, ProjectSummary } from '@erd/contracts';
import { harness } from './harness';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(() => h?.close());

describe('contas', () => {
  it('cadastro exige verificação de e-mail; o link chega e loga', async () => {
    const b = h.browser();
    const r = await b.json('/api/auth/sign-up/email', { method: 'POST', json: { name: 'Zé', email: 'ze@x.com', password: 'senha-forte-123' } });
    expect(r.status).toBe(200);
    // sem verificar, o login é recusado
    const login = await b.json('/api/auth/sign-in/email', { method: 'POST', json: { email: 'ze@x.com', password: 'senha-forte-123' } });
    expect(login.status).toBe(403);
    expect((await h.waitMail('ze@x.com')).subject).toBe('Confirme seu e-mail');
    const ana = await h.signup('Ana');
    expect(ana.id).toBeTruthy();
  });

  it('reset de senha manda e-mail com link de uso único', async () => {
    await h.signup('Bia');
    const b = h.browser();
    const r = await b.json('/api/auth/request-password-reset', { method: 'POST', json: { email: 'bia@x.com', redirectTo: '/reset-password' } });
    expect(r.status).toBe(200);
    const mail = await h.waitMail('bia@x.com', 'Redefinir senha');
    const link = mail.text.match(/https?:\/\/\S+reset-password\S+/)![0];
    const res = await b.req(link);
    const loc = res.headers.get('location')!;
    const token = new URL(loc, 'http://x').searchParams.get('token')!;
    const ok = await b.json('/api/auth/reset-password', { method: 'POST', json: { newPassword: 'outra-senha-456', token } });
    expect(ok.status).toBe(200);
    const again = await b.json('/api/auth/reset-password', { method: 'POST', json: { newPassword: 'mais-uma-789', token } });
    expect(again.status).toBe(400);
    const login = await h.browser().json('/api/auth/sign-in/email', { method: 'POST', json: { email: 'bia@x.com', password: 'outra-senha-456' } });
    expect(login.status).toBe(200);
  });

  it('a API recusa quem não está logado', async () => {
    const r = await h.browser().json('/api/projects');
    expect(r.status).toBe(401);
  });
});

describe('projetos e canvases', () => {
  it('cria, lista, abre, salva estado, recarrega e exporta', async () => {
    const ana = await h.signup('Carla');
    const created = await ana.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Loja', template: 'sample' } });
    expect(created.status).toBe(201);
    const list = await ana.json<ProjectSummary[]>('/api/projects');
    expect(list.body.map((p) => p.name)).toEqual(['Loja']);
    expect(list.body[0].role).toBe('owner');
    const detail = await ana.json<ProjectDetail>(`/api/projects/${created.body.id}`);
    expect(detail.body.canvases).toHaveLength(1);
    expect(detail.body.canvases[0].kind).toBe('erd');

    // carrega o estado, edita e manda o update
    const state = new Uint8Array(await (await ana.req(`/api/canvases/${created.body.canvasId}/state`)).arrayBuffer());
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    expect(projectDoc(doc).schema.tables.map((t) => t.name)).toContain('customers');
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const before = projectDoc(doc);
    doc.transact(() => applyDiff(doc, before, produce(before, (d) => void (d.schema.tables[0].name = 'clientes'))), LOCAL_ORIGIN);
    for (const u of updates) {
      const r = await ana.req(`/api/canvases/${created.body.canvasId}/updates`, { method: 'POST', body: u as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
      expect(r.status).toBe(200);
    }
    // "recarregar": o estado salvo tem a edição
    const again = new Y.Doc();
    Y.applyUpdate(again, new Uint8Array(await (await ana.req(`/api/canvases/${created.body.canvasId}/state`)).arrayBuffer()));
    expect(projectDoc(again).schema.tables[0].name).toBe('clientes');

    const zip = unzipSync(new Uint8Array(await (await ana.req(`/api/canvases/${created.body.canvasId}/export?format=zip`)).arrayBuffer()));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['project.json', 'schema.sql', 'schema.prisma', 'schema.ts']));
    expect(strFromU8(zip['schema.sql'])).toContain('CREATE TABLE clientes');
  });

  it('import: o servidor valida o estado inicial e recusa lixo', async () => {
    const b = await h.signup('Dani');
    const p = emptyProjectDoc('Importado');
    p.schema.tables.push({ id: 't1', name: 'x', columns: [], primaryKey: [], uniques: [], indexes: [], checks: [] });
    const ok = await b.json<{ id: string }>('/api/projects', { method: 'POST', json: { name: 'Importado', initialState: Buffer.from(fromProject(p)).toString('base64') } });
    expect(ok.status).toBe(201);
    // um documento com uma tabela sem nome válido
    const bad = new Y.Doc();
    const t = new Y.Map<unknown>();
    bad.getMap('tables').set('t_bad', t);
    t.set('name', 42);
    const r = await b.json<{ error: string }>('/api/projects', { method: 'POST', json: { name: 'Lixo', initialState: Buffer.from(Y.encodeStateAsUpdate(bad)).toString('base64') } });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/inválida/);
  });

  it('quem não é membro não vê nem edita (404, sem revelar que existe)', async () => {
    const dono = await h.signup('Edu');
    const outro = await h.signup('Fabio');
    const p = await dono.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name: 'Secreto' } });
    expect((await outro.json(`/api/projects/${p.body.id}`)).status).toBe(404);
    expect((await outro.req(`/api/canvases/${p.body.canvasId}/state`)).status).toBe(404);
    const up = await outro.req(`/api/canvases/${p.body.canvasId}/updates`, { method: 'POST', body: new Uint8Array([0, 0]) as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
    expect(up.status).toBe(404);
  });

  it('renomear, excluir (soft) e canvas novo', async () => {
    const b = await h.signup('Gabi');
    const p = await b.json<{ id: string }>('/api/projects', { method: 'POST', json: { name: 'A' } });
    expect((await b.json(`/api/projects/${p.body.id}`, { method: 'PATCH', json: { name: 'B' } })).status).toBe(200);
    expect((await b.json<ProjectDetail>(`/api/projects/${p.body.id}`)).body.name).toBe('B');
    const c = await b.json<{ id: string }>(`/api/projects/${p.body.id}/canvases`, { method: 'POST', json: { kind: 'erd', name: 'Outro' } });
    expect(c.status).toBe(201);
    expect((await b.json(`/api/projects/${p.body.id}/canvases`, { method: 'POST', json: { kind: 'flow', name: 'Fluxos' } })).status).toBe(422);
    expect((await b.json(`/api/projects/${p.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await b.json(`/api/projects/${p.body.id}`)).status).toBe(404);
  });
});
