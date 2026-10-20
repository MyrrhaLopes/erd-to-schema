import { createHash } from 'node:crypto';
import { DriveError, type DriveFile, type DriveFolder, type DriveProvider, type DriveRevision, type DriveUser, type NewFile } from './provider';

interface FFolder {
  id: string;
  name: string;
  owner: string;
  /** Contas com acesso de Editor (Drive) à pasta */
  editors: Set<string>;
}

interface FFile {
  id: string;
  name: string;
  owner: string;
  parents: string[];
  trashed: boolean;
  locked: boolean;
  ownerRestricted: boolean;
  appProperties: Record<string, string>;
  revisions: { id: string; bytes: Uint8Array; by: string; at: string }[];
}

type Op = keyof DriveProvider;

/**
 * Drive em memória que imita o Google no que o plano usa (§11): `contentRestrictions`
 * (recusa update com readOnly; só o dono tira com ownerRestricted), md5, revisões, lixeira,
 * 404, permissões de Editor na pasta e falhas injetáveis (429, 5xx, 403). O token é
 * `fake:<userId>`. Com `DRIVE_PROVIDER=fake` a API usa este provider (E2E e dev sem Google).
 */
export class FakeDrive implements DriveProvider {
  readonly kind = 'fake' as const;
  readonly folders = new Map<string, FFolder>();
  readonly files = new Map<string, FFile>();
  /** Tokens revogados (simula `invalid_grant`) */
  readonly revoked = new Set<string>();
  private failures: { op: Op | '*'; status: number; times: number }[] = [];
  private seq = 0;
  calls: Op[] = [];

  /** Faz as próximas `times` chamadas de `op` falharem com `status` */
  failNext(op: Op | '*', status: number, times = 1) {
    this.failures.push({ op, status, times });
  }

  private user(token: string): string {
    if (!token.startsWith('fake:') || this.revoked.has(token)) throw new DriveError('invalid_grant', 'token inválido ou revogado', 401);
    return token.slice(5);
  }

  private hit(op: Op) {
    this.calls.push(op);
    const f = this.failures.find((x) => (x.op === op || x.op === '*') && x.times > 0);
    if (!f) return;
    f.times--;
    if (f.status === 429) throw new DriveError('rate_limited', 'rate limited', 429);
    if (f.status >= 500) throw new DriveError('server', 'erro do Google', f.status);
    if (f.status === 404) throw new DriveError('not_found', 'não encontrado', 404);
    throw new DriveError('forbidden', 'proibido', f.status);
  }

  /** Pastas que a conta enxerga (o "Picker" do modo fake) */
  listFolders(userId: string) {
    this.ensureFolders(userId);
    return [...this.folders.values()].filter((f) => f.owner === userId || f.editors.has(userId)).map((f) => ({ id: f.id, name: f.name }));
  }

  ensureFolders(userId: string) {
    if ([...this.folders.values()].some((f) => f.owner === userId)) return;
    for (const name of ['Documentos', 'Projetos', 'Arquivo morto']) this.addFolder(userId, name);
  }

  addFolder(owner: string, name: string, editors: string[] = []) {
    const id = `fld_${owner.slice(-6)}_${++this.seq}`;
    this.folders.set(id, { id, name, owner, editors: new Set(editors) });
    return id;
  }

  private canWriteFolder(user: string, folderId: string) {
    const f = this.folders.get(folderId);
    return !!f && (f.owner === user || f.editors.has(user));
  }

  private canSeeFile(user: string, f: FFile) {
    return f.owner === user || f.parents.some((p) => this.canWriteFolder(user, p));
  }

  private view(f: FFile, viewer: string): DriveFile {
    const head = f.revisions.at(-1)!;
    const last = this.lastUser(head.by);
    return {
      id: f.id,
      name: f.name,
      md5Checksum: createHash('md5').update(head.bytes).digest('hex'),
      headRevisionId: head.id,
      size: head.bytes.byteLength,
      trashed: f.trashed,
      parents: [...f.parents],
      webViewLink: `https://drive.fake/file/d/${f.id}/view`,
      locked: f.locked,
      ownerRestricted: f.ownerRestricted,
      canModifyOwnerContentRestriction: f.owner === viewer,
      lastModifyingUser: last,
      appProperties: { ...f.appProperties },
    };
  }

  private lastUser(id: string): DriveUser {
    return { name: id, email: `${id}@fake` };
  }

  private file(user: string, fileId: string): FFile {
    const f = this.files.get(fileId);
    if (!f || !this.canSeeFile(user, f)) throw new DriveError('not_found', 'arquivo não encontrado', 404);
    return f;
  }

  async about(token: string) {
    const u = this.user(token);
    this.hit('about');
    return { name: `Conta Google de ${u}`, email: `${u}@gmail.fake` };
  }

  async getFolder(token: string, folderId: string): Promise<DriveFolder> {
    const u = this.user(token);
    this.hit('getFolder');
    const f = this.folders.get(folderId);
    if (!f || !(f.owner === u || f.editors.has(u))) throw new DriveError('not_found', 'pasta não encontrada', 404);
    return { id: f.id, name: f.name, isFolder: true, canAddChildren: true, path: `Meu Drive / ${f.name}` };
  }

  async getFile(token: string, fileId: string) {
    const u = this.user(token);
    this.hit('getFile');
    const f = this.files.get(fileId);
    if (!f || !this.canSeeFile(u, f)) return null;
    return this.view(f, u);
  }

  async createFile(token: string, n: NewFile) {
    const u = this.user(token);
    this.hit('createFile');
    if (!this.canWriteFolder(u, n.folderId)) throw new DriveError('forbidden', 'sem acesso à pasta', 403);
    const id = `file_${++this.seq}`;
    const f: FFile = {
      id,
      name: n.name,
      owner: u,
      parents: [n.folderId],
      trashed: false,
      locked: true,
      ownerRestricted: true,
      appProperties: { ...n.appProperties },
      revisions: [{ id: `rev_${++this.seq}`, bytes: n.bytes, by: u, at: new Date().toISOString() }],
    };
    this.files.set(id, f);
    return this.view(f, u);
  }

  async updateContent(token: string, fileId: string, bytes: Uint8Array, name?: string) {
    const u = this.user(token);
    this.hit('updateContent');
    const f = this.file(u, fileId);
    if (f.locked) throw new DriveError('restricted', 'o arquivo está bloqueado (contentRestrictions.readOnly)', 403);
    if (f.owner !== u && !f.parents.some((p) => this.canWriteFolder(u, p))) throw new DriveError('forbidden', 'sem permissão', 403);
    f.revisions.push({ id: `rev_${++this.seq}`, bytes, by: u, at: new Date().toISOString() });
    if (name) f.name = name;
    return this.view(f, u);
  }

  async setLock(token: string, fileId: string, locked: boolean) {
    const u = this.user(token);
    this.hit('setLock');
    const f = this.file(u, fileId);
    if (f.ownerRestricted && f.owner !== u) throw new DriveError('forbidden', 'só o dono pode mudar o bloqueio', 403);
    f.locked = locked;
    f.ownerRestricted = locked;
    return this.view(f, u);
  }

  async move(token: string, fileId: string, to: string, from: string[]) {
    const u = this.user(token);
    this.hit('move');
    const f = this.file(u, fileId);
    f.parents = [...f.parents.filter((p) => !from.includes(p)), to];
    return this.view(f, u);
  }

  async listRevisions(token: string, fileId: string): Promise<DriveRevision[]> {
    const u = this.user(token);
    this.hit('listRevisions');
    return this.file(u, fileId).revisions.map((r) => ({ id: r.id, modifiedTime: r.at, lastModifyingUser: this.lastUser(r.by) }));
  }

  async deleteRevision(token: string, fileId: string, revisionId: string) {
    const u = this.user(token);
    this.hit('deleteRevision');
    const f = this.file(u, fileId);
    if (f.revisions.at(-1)?.id === revisionId) throw new DriveError('bad_request', 'não dá para apagar a revisão atual', 400);
    f.revisions = f.revisions.filter((r) => r.id !== revisionId);
  }

  async deleteFile(token: string, fileId: string) {
    const u = this.user(token);
    this.hit('deleteFile');
    const f = this.files.get(fileId);
    if (!f) return;
    if (f.owner !== u) throw new DriveError('forbidden', 'só o dono apaga', 403);
    this.files.delete(fileId);
  }

  async findAppFiles(token: string, folderId: string, canvasId: string) {
    const u = this.user(token);
    this.hit('findAppFiles');
    return [...this.files.values()].filter((f) => f.parents.includes(folderId) && f.appProperties.erdCanvasId === canvasId && this.canSeeFile(u, f)).map((f) => this.view(f, u));
  }

  /* ---------------- o que alguém faz pelo Drive (testes) ---------------- */

  /** Edição pelo Drive por `userId` (só passa se o arquivo estiver desbloqueado) */
  externalEdit(userId: string, fileId: string, bytes = new TextEncoder().encode(`editado por ${userId}`)) {
    const f = this.files.get(fileId)!;
    if (f.locked) throw new DriveError('restricted', 'bloqueado', 403);
    f.revisions.push({ id: `rev_${++this.seq}`, bytes, by: userId, at: new Date().toISOString() });
  }

  /** O dono desbloqueia pelo Drive (só ele consegue) */
  externalUnlock(userId: string, fileId: string) {
    const f = this.files.get(fileId)!;
    if (f.ownerRestricted && f.owner !== userId) throw new DriveError('forbidden', 'só o dono', 403);
    f.locked = false;
    f.ownerRestricted = false;
  }

  trash(fileId: string) {
    this.files.get(fileId)!.trashed = true;
  }

  externalMove(fileId: string, folderId: string) {
    this.files.get(fileId)!.parents = [folderId];
  }
}
