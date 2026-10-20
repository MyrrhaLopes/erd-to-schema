import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parse as pgParse } from 'libpg-query';
import { applyDiff, fromProject, LOCAL_ORIGIN, projectDoc, type ProjectDoc } from '@erd/crdt';
import { parseSql } from '@erd/model/formats/sql/parse';
import { columnSql } from '@erd/model/formats/sql/generate';
import { reconcile } from '@erd/model/reconcile';
import { emptyProject } from '@erd/model/project';
import type { DriveProject, DrivePublication, Notification, Version } from '@erd/contracts';
import { canvasVersions, driveBindings, drivePendingDeletions, eq } from '@erd/db';
import { FakeDrive } from '../src/drive/fake';
import type { InlineJobQueue } from '../src/queue';
import type { DriveJob } from '../src/drive/service';
import { harness } from './harness';

/**
 * Integração do documento no Drive (drive-docx-plan §11) com o `FakeDrive`: o mesmo
 * comportamento que o plano assume do Google (bloqueio, md5, revisões, lixeira, 404, 429).
 */
const fake = new FakeDrive();
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness({ driveProvider: fake });
});
afterAll(() => h?.close());

type B = Awaited<ReturnType<typeof h.signup>>;
const idle = () => (h.deps.drive!.jobs as InlineJobQueue<DriveJob>).idle();

const SQL = `CREATE TABLE "Person" (id bigserial PRIMARY KEY, name text NOT NULL);
CREATE TABLE "Order" (id bigserial PRIMARY KEY, "personId" bigint NOT NULL REFERENCES "Person"(id) ON DELETE CASCADE);
-- @erd:tags Person "Módulo A — Cadastro"`;

async function initial(): Promise<ProjectDoc> {
  const r = await parseSql(SQL, pgParse as never);
  if (!r.ok) throw new Error('parse');
  const p = emptyProject('Loja');
  const rec = reconcile(p, r.parsed, 'sql', columnSql);
  return { name: 'Loja', schema: rec.schema, layout: {}, meta: rec.meta, notes: [] };
}

async function newProject(owner: B) {
  const r = await owner.json<{ id: string; canvasId: string }>('/api/projects', {
    method: 'POST',
    json: { name: 'Loja', initialState: Buffer.from(fromProject(await initial())).toString('base64') },
  });
  expect(r.status).toBe(201);
  return r.body;
}

/** Edita o canvas como um cliente faria: diff aplicado num documento e o update enviado à API */
async function edit(b: B, canvasId: string, recipe: (d: ProjectDoc) => ProjectDoc) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await (await b.req(`/api/canvases/${canvasId}/state`)).arrayBuffer()));
  const sv = Y.encodeStateVector(doc);
  const before = projectDoc(doc);
  doc.transact(() => applyDiff(doc, before, recipe(structuredClone(before))), LOCAL_ORIGIN);
  const r = await b.req(`/api/canvases/${canvasId}/updates`, {
    method: 'POST',
    body: Y.encodeStateAsUpdate(doc, sv) as BodyInit,
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(r.status).toBe(200);
}

const review = async (b: B, canvasId: string) =>
  (await b.json<{ hash: string; nextVersion: number; unchanged: boolean; review: { modules: { module: string }[] } }>(`/api/canvases/${canvasId}/drive/review`)).body;

async function publish(b: B, canvasId: string, extra: { revertedFrom?: number } = {}) {
  const { hash } = await review(b, canvasId);
  const r = await b.json<{ status: string; version: number; jobId: string | null }>(`/api/canvases/${canvasId}/drive/publish`, {
    method: 'POST',
    json: { reviewedHash: hash, ...extra },
  });
  await idle();
  return r;
}

const history = async (b: B, canvasId: string) => (await b.json<DrivePublication[]>(`/api/canvases/${canvasId}/drive/publications`)).body;
const binding = async (canvasId: string) => (await h.db.select().from(driveBindings).where(eq(driveBindings.canvasId, canvasId)))[0]!;

async function connect(owner: B, projectId: string, canvasId: string, folderName = 'Projetos') {
  expect((await owner.json(`/api/projects/${projectId}/drive/fake-connect`, { method: 'POST' })).status).toBe(200);
  const picker = await owner.json<{ folders: { id: string; name: string }[] }>(`/api/projects/${projectId}/drive/picker-token`);
  const folder = picker.body.folders.find((f) => f.name === folderName)!;
  const r = await owner.json(`/api/canvases/${canvasId}/drive/folder`, { method: 'PUT', json: { folderId: folder.id } });
  expect(r.status).toBe(201);
  return folder;
}

async function setup() {
  const owner = await h.signup(`Dona${Math.random().toString(36).slice(2, 6)}`);
  const p = await newProject(owner);
  const folder = await connect(owner, p.id, p.canvasId);
  return { owner, p, folder };
}

describe('publicar (§3)', () => {
  it('primeira publicação cria o arquivo bloqueado; sem mudanças não publica; hash revisado desatualizado é recusado', async () => {
    const { owner, p, folder } = await setup();
    const rv = await review(owner, p.canvasId);
    expect(rv.nextVersion).toBe(1);
    expect(rv.review.modules.map((m) => m.module)).toEqual(['Módulo A']);

    const r = await publish(owner, p.canvasId);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'queued', version: 1 });
    expect((await owner.json(`/api/canvases/${p.canvasId}/drive/jobs/${r.body.jobId}`)).body).toEqual({ state: 'completed' });

    const b = await binding(p.canvasId);
    expect(b).toMatchObject({ lastVersion: 1, lock: 'locked', status: 'active', folderId: folder.id, fileName: 'Modelo_Dados_loja.docx' });
    const file = fake.files.get(b.fileId!)!;
    expect(file.locked && file.ownerRestricted).toBe(true);
    expect(file.parents).toEqual([folder.id]);
    expect(file.appProperties).toEqual({ erdCanvasId: p.canvasId, erdProjectId: p.id });
    const [pub] = await history(owner, p.canvasId);
    expect(pub).toMatchObject({ action: 'published', version: 1, requestedBy: { id: owner.id } });

    // a versão do canvas da publicação é protegida
    const versions = (await owner.json<Version[]>(`/api/canvases/${p.canvasId}/versions`)).body;
    const v = versions.find((x) => x.id === pub.canvasVersionId)!;
    expect(v).toMatchObject({ label: 'Publicação v1 no Drive', protected: true });
    expect((await owner.json(`/api/canvases/${p.canvasId}/versions/${v.id}`, { method: 'DELETE' })).status).toBe(422);

    // nada mudou
    const again = await publish(owner, p.canvasId);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'unchanged', version: 1 });

    // o modelo mudou depois da revisão
    const stale = await review(owner, p.canvasId);
    await edit(owner, p.canvasId, (d) => ((d.schema.tables[0].comment = 'Pessoas'), d));
    const conflict = await owner.json(`/api/canvases/${p.canvasId}/drive/publish`, { method: 'POST', json: { reviewedHash: stale.hash } });
    expect(conflict.status).toBe(409);

    // publica de novo: mesmo arquivo, mesmo link, uma revisão só no Drive
    const v2 = await publish(owner, p.canvasId);
    expect(v2.body.version).toBe(2);
    const b2 = await binding(p.canvasId);
    expect(b2.fileId).toBe(b.fileId);
    expect(fake.files.get(b.fileId!)!.revisions).toHaveLength(1);
    expect(fake.files.get(b.fileId!)!.locked).toBe(true);
  });

  it('papéis: editor publica com o token do dono; leitor não; só o dono escolhe a pasta', async () => {
    const { owner, p, folder } = await setup();
    const ed = await h.signup(`Edi${Math.random().toString(36).slice(2, 6)}`);
    const vi = await h.signup(`Vivi${Math.random().toString(36).slice(2, 6)}`);
    await owner.json(`/api/projects/${p.id}/members`, { method: 'POST', json: { email: ed.email, role: 'editor' } });
    await owner.json(`/api/projects/${p.id}/members`, { method: 'POST', json: { email: vi.email, role: 'viewer' } });
    const { hash } = await review(vi, p.canvasId);
    expect((await vi.json(`/api/canvases/${p.canvasId}/drive/publish`, { method: 'POST', json: { reviewedHash: hash } })).status).toBe(403);
    expect((await ed.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: folder.id } })).status).toBe(403);
    expect((await ed.json(`/api/projects/${p.id}/drive/picker-token`)).status).toBe(403);
    const r = await publish(ed, p.canvasId);
    expect(r.status).toBe(202);
    const file = fake.files.get((await binding(p.canvasId)).fileId!)!;
    expect(file.owner).toBe(owner.id);
    expect((await history(vi, p.canvasId))[0]).toMatchObject({ action: 'published', requestedBy: { id: ed.id } });
    const proj = (await vi.json<DriveProject>(`/api/projects/${p.id}/drive`)).body;
    expect(proj).toMatchObject({ enabled: true, isOwner: false, account: { connected: true } });
    expect(proj.bindings[0]).toMatchObject({ lastVersion: 1, lastPublishedBy: ed.name, folderName: 'Projetos' });
    // .docx na hora, sem Drive
    const docx = await vi.req(`/api/canvases/${p.canvasId}/docx`);
    expect(docx.status).toBe(200);
    expect(docx.headers.get('content-type')).toMatch(/wordprocessingml/);
    expect(
      Buffer.from(await docx.arrayBuffer())
        .subarray(0, 2)
        .toString(),
    ).toBe('PK');
  });

  it('o bloqueio: outra conta com acesso de Editor à pasta não edita nem desbloqueia', async () => {
    const { owner, p } = await setup();
    await publish(owner, p.canvasId);
    const b = await binding(p.canvasId);
    fake.folders.get(b.folderId)!.editors.add('intruso');
    expect(() => fake.externalUnlock('intruso', b.fileId!)).toThrow(/dono/);
    expect(() => fake.externalEdit('intruso', b.fileId!)).toThrow(/bloqueado/);
  });

  it('edição externa pelo dono é detectada, avisada e sobrescrita na próxima publicação', async () => {
    const { owner, p } = await setup();
    await publish(owner, p.canvasId);
    const b = await binding(p.canvasId);
    fake.externalUnlock(owner.id, b.fileId!);
    fake.externalEdit(owner.id, b.fileId!);
    // a auditoria pega o desbloqueio e a edição
    await h.deps.drive!.audit(p.canvasId);
    let hist = await history(owner, p.canvasId);
    expect(hist.map((x) => x.action)).toEqual(expect.arrayContaining(['external_edit_detected', 'relocked']));
    expect(hist.find((x) => x.action === 'external_edit_detected')!.externalActor).toEqual({ name: owner.id, email: `${owner.id}@fake` });
    expect(fake.files.get(b.fileId!)!.locked).toBe(true);
    const n = (await owner.json<{ items: Notification[] }>('/api/notifications')).body.items;
    expect(n.some((x) => x.type === 'drive-alert' && /editou/.test(String(x.payload.message)))).toBe(true);
    await h.waitMail(owner.email, 'Aviso sobre o documento no Google Drive');
    // a auditoria de novo não repete o aviso
    await h.deps.drive!.audit(p.canvasId);
    expect((await history(owner, p.canvasId)).filter((x) => x.action === 'external_edit_detected')).toHaveLength(1);

    await edit(owner, p.canvasId, (d) => ((d.schema.tables[1].comment = 'Pedidos'), d));
    await publish(owner, p.canvasId);
    hist = await history(owner, p.canvasId);
    expect(hist[0]).toMatchObject({ action: 'published', version: 2 });
    const head = fake.files.get(b.fileId!)!.revisions;
    expect(head).toHaveLength(1);
    expect(head[0].by).toBe(owner.id);
  });

  it('arquivo apagado ou movido por fora: recria na publicação, devolve à pasta na auditoria', async () => {
    const { owner, p, folder } = await setup();
    await publish(owner, p.canvasId);
    const b = await binding(p.canvasId);
    fake.externalMove(b.fileId!, fake.addFolder(owner.id, 'Outra'));
    await h.deps.drive!.audit(p.canvasId);
    expect(fake.files.get(b.fileId!)!.parents).toEqual([folder.id]);
    expect((await history(owner, p.canvasId))[0].action).toBe('moved_externally');

    fake.trash(b.fileId!);
    await edit(owner, p.canvasId, (d) => ((d.schema.tables[0].comment = 'x'), d));
    await publish(owner, p.canvasId);
    const b2 = await binding(p.canvasId);
    expect(b2.fileId).not.toBe(b.fileId);
    expect(fake.files.has(b.fileId!)).toBe(false);
    expect((await history(owner, p.canvasId)).slice(0, 2).map((x) => x.action)).toEqual(['published', 'recreated']);
  });

  it('reverter: a versão protegida volta ao canvas e sai como uma publicação nova com revertedFrom', async () => {
    const { owner, p } = await setup();
    await publish(owner, p.canvasId);
    const v1 = (await history(owner, p.canvasId))[0];
    const hash1 = (await binding(p.canvasId)).lastContentHash;
    await edit(owner, p.canvasId, (d) => ((d.schema.tables[0].name = 'People'), d));
    await publish(owner, p.canvasId);
    // o cliente aplica a versão do canvas como uma edição comum (o restoreVersion da web)
    const vstate = new Uint8Array(await (await owner.req(`/api/canvases/${p.canvasId}/versions/${v1.canvasVersionId}/state`)).arrayBuffer());
    const vdoc = new Y.Doc();
    Y.applyUpdate(vdoc, vstate);
    const target = projectDoc(vdoc);
    await edit(owner, p.canvasId, (d) => ({ ...target, name: d.name }));
    const r = await publish(owner, p.canvasId, { revertedFrom: 1 });
    expect(r.body.version).toBe(3);
    const top = (await history(owner, p.canvasId))[0];
    expect(top).toMatchObject({ action: 'published', version: 3, revertedFrom: 1 });
    expect((await binding(p.canvasId)).lastContentHash).toBe(hash1);
  });

  it('retentativa em 429; token revogado vira needs_reconnect com aviso; versões seguem em ordem', async () => {
    const { owner, p } = await setup();
    fake.failNext('updateContent', 429);
    fake.failNext('createFile', 503);
    await publish(owner, p.canvasId);
    expect((await binding(p.canvasId)).lastVersion).toBe(1);
    await edit(owner, p.canvasId, (d) => ((d.schema.tables[0].comment = 'a'), d));
    fake.failNext('updateContent', 429);
    await publish(owner, p.canvasId);
    expect((await binding(p.canvasId)).lastVersion).toBe(2);

    fake.revoked.add(`fake:${owner.id}`);
    await edit(owner, p.canvasId, (d) => ((d.schema.tables[0].comment = 'b'), d));
    await publish(owner, p.canvasId);
    expect((await binding(p.canvasId)).status).toBe('needs_reconnect');
    const top = (await history(owner, p.canvasId))[0];
    expect(top).toMatchObject({ action: 'failed' });
    // a versão do canvas da publicação que falhou não fica protegida
    const [cv] = await h.db.select().from(canvasVersions).where(eq(canvasVersions.id, top.canvasVersionId!));
    expect(cv.protected).toBe(false);
    const n = (await owner.json<{ items: Notification[] }>('/api/notifications')).body.items;
    expect(n.some((x) => x.type === 'drive-alert' && /Reconecte/.test(String(x.payload.title)))).toBe(true);
    fake.revoked.delete(`fake:${owner.id}`);
    await publish(owner, p.canvasId);
    expect(await binding(p.canvasId)).toMatchObject({ status: 'active', lastVersion: 3 });
  });

  it('concorrência: publicações do mesmo canvas rodam em série', async () => {
    const { owner, p } = await setup();
    const { hash } = await review(owner, p.canvasId);
    const sends = await Promise.all([1, 2, 3].map(() => owner.json(`/api/canvases/${p.canvasId}/drive/publish`, { method: 'POST', json: { reviewedHash: hash } })));
    expect(sends.every((s) => s.status === 202)).toBe(true);
    await idle();
    const pubs = (await history(owner, p.canvasId)).filter((x) => x.action === 'published').map((x) => x.version);
    expect(pubs).toEqual([3, 2, 1]);
    expect(fake.files.get((await binding(p.canvasId)).fileId!)!.revisions).toHaveLength(1);
  });
});

describe('configuração', () => {
  it('diz quais variáveis faltam para o Drive do Google ligar', async () => {
    const { driveMissing, loadEnv } = await import('../src/env');
    const base = {
      APP_URL: 'http://a.test',
      BETTER_AUTH_URL: 'http://a.test',
      DATABASE_URL: 'postgres://x@y/z',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
      COLLAB_JWT_SECRET: 'y'.repeat(40),
    };
    expect(driveMissing(loadEnv(base))).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_PICKER_API_KEY', 'GOOGLE_PROJECT_NUMBER']);
    expect(driveMissing(loadEnv({ ...base, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_PICKER_API_KEY: 'k' }))).toEqual(['GOOGLE_PROJECT_NUMBER']);
    expect(driveMissing(loadEnv({ ...base, DRIVE_PROVIDER: 'fake' }))).toEqual([]);
    const owner = await h.signup(`Cfg${Math.random().toString(36).slice(2, 6)}`);
    expect((await owner.json('/api/drive/config')).body).toMatchObject({ enabled: true, provider: 'fake', missing: [] });
  });
});

describe('trocar a pasta (§5) e desconectar', () => {
  it('cria na nova, exclui definitivamente na antiga, sem versão nova', async () => {
    const { owner, p, folder } = await setup();
    await publish(owner, p.canvasId);
    const old = await binding(p.canvasId);
    const target = fake.listFolders(owner.id).find((f) => f.name === 'Arquivo morto')!;
    const r = await owner.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: target.id } });
    expect(r.status).toBe(202);
    await idle();
    const b = await binding(p.canvasId);
    expect(b).toMatchObject({ folderId: target.id, folderName: 'Arquivo morto', lastVersion: 1, lock: 'locked' });
    expect(b.fileId).not.toBe(old.fileId);
    expect(fake.files.has(old.fileId!)).toBe(false);
    expect(fake.files.get(b.fileId!)!.parents).toEqual([target.id]);
    const top = (await history(owner, p.canvasId))[0];
    expect(top).toMatchObject({ action: 'folder_changed', previousFolderName: folder.name, folderName: 'Arquivo morto' });
    expect(top.oldFileDeletedAt).not.toBeNull();
    // mesma pasta: nada a fazer
    expect((await owner.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: target.id } })).body).toMatchObject({ status: 'unchanged' });
  });

  it('falha ao criar: nada muda; falha ao excluir: fica pendente e o cleanup resolve', async () => {
    const { owner, p, folder } = await setup();
    await publish(owner, p.canvasId);
    const old = await binding(p.canvasId);
    const target = fake.listFolders(owner.id).find((f) => f.name === 'Documentos')!;
    fake.failNext('createFile', 403);
    await owner.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: target.id } });
    await idle();
    expect(await binding(p.canvasId)).toMatchObject({ folderId: folder.id, fileId: old.fileId });
    expect(fake.files.has(old.fileId!)).toBe(true);
    expect((await history(owner, p.canvasId))[0]).toMatchObject({ action: 'failed' });

    fake.failNext('deleteFile', 500);
    await owner.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: target.id } });
    await idle();
    expect((await binding(p.canvasId)).folderId).toBe(target.id);
    const [pend] = await h.db.select().from(drivePendingDeletions).where(eq(drivePendingDeletions.fileId, old.fileId!));
    expect(pend).toMatchObject({ attempts: 1 });
    expect((await owner.json<DriveProject>(`/api/projects/${p.id}/drive`)).body.bindings[0].pendingDeletions).toHaveLength(1);
    await h.db.update(drivePendingDeletions).set({ nextAttemptAt: new Date(0) });
    await (h.deps.drive!.jobs as InlineJobQueue<DriveJob>).runSchedule('cleanup');
    expect(fake.files.has(old.fileId!)).toBe(false);
    expect(await h.db.select().from(drivePendingDeletions).where(eq(drivePendingDeletions.fileId, old.fileId!))).toHaveLength(0);
  });

  it('desconectar exclui o arquivo e pausa; escolher a pasta de novo reativa sem perder a numeração', async () => {
    const { owner, p, folder } = await setup();
    await publish(owner, p.canvasId);
    const old = await binding(p.canvasId);
    expect((await owner.json(`/api/canvases/${p.canvasId}/drive?deleteFile=true`, { method: 'DELETE' })).status).toBe(202);
    await idle();
    expect(fake.files.has(old.fileId!)).toBe(false);
    expect(await binding(p.canvasId)).toMatchObject({ status: 'paused', fileId: null });
    const { hash } = await review(owner, p.canvasId);
    expect((await owner.json(`/api/canvases/${p.canvasId}/drive/publish`, { method: 'POST', json: { reviewedHash: hash } })).status).toBe(409);
    expect((await owner.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: folder.id } })).status).toBe(200);
    const r = await publish(owner, p.canvasId);
    expect(r.body.version).toBe(2);
  });
});

describe('transferência de posse com Drive (§6)', () => {
  it('as publicações seguem no Drive do dono antigo até o novo escolher a pasta; aí o arquivo muda de conta', async () => {
    const { owner, p } = await setup();
    const novo = await h.signup(`Novo${Math.random().toString(36).slice(2, 6)}`);
    await owner.json(`/api/projects/${p.id}/members`, { method: 'POST', json: { email: novo.email, role: 'editor' } });
    await publish(owner, p.canvasId);
    const old = await binding(p.canvasId);

    const t = await owner.json<{ driveNote: boolean }>(`/api/projects/${p.id}/transfer`, { method: 'POST', json: { userId: novo.id } });
    expect(t.body.driveNote).toBe(true);
    expect((await binding(p.canvasId)).status).toBe('transfer_pending');
    const n = (await novo.json<{ items: Notification[] }>('/api/notifications')).body.items;
    expect(n.find((x) => x.type === 'project-transferred')!.payload).toMatchObject({ driveNote: true });
    await h.waitMail(novo.email, 'Um projeto foi transferido para você');

    // o antigo dono (agora editor) e o novo publicam; o arquivo continua no Drive do antigo
    await edit(novo, p.canvasId, (d) => ((d.schema.tables[0].comment = 'novo dono'), d));
    await publish(novo, p.canvasId);
    expect(await binding(p.canvasId)).toMatchObject({ status: 'transfer_pending', lastVersion: 2, connectedUserId: owner.id, fileId: old.fileId });

    // o novo dono conecta o Drive dele e escolhe uma pasta
    const folder = await (async () => {
      await novo.json(`/api/projects/${p.id}/drive/fake-connect`, { method: 'POST' });
      return (await novo.json<{ folders: { id: string; name: string }[] }>(`/api/projects/${p.id}/drive/picker-token`)).body.folders[0];
    })();
    expect((await novo.json(`/api/canvases/${p.canvasId}/drive/folder`, { method: 'PUT', json: { folderId: folder.id } })).status).toBe(202);
    await idle();
    const b = await binding(p.canvasId);
    expect(b).toMatchObject({ status: 'active', connectedUserId: novo.id, folderId: folder.id, lastVersion: 2 });
    expect(fake.files.get(b.fileId!)!.owner).toBe(novo.id);
    expect(fake.files.has(old.fileId!)).toBe(false);
    expect((await history(novo, p.canvasId)).map((x) => x.action)).toEqual(expect.arrayContaining(['owner_transferred', 'folder_changed']));
  });
});
