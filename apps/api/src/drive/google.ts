import { DOCX_MIME, DriveError, type DriveFile, type DriveFolder, type DriveProvider, type DriveRevision, type DriveUser, type NewFile } from './provider';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS =
  'id,name,md5Checksum,headRevisionId,size,trashed,parents,webViewLink,contentRestrictions,capabilities(canModifyOwnerContentRestriction),lastModifyingUser(displayName,emailAddress),appProperties';
/** Acima disso, upload *resumable* (§9.1) */
const RESUMABLE_OVER = 5 * 1024 * 1024;

interface RawFile {
  id: string;
  name: string;
  md5Checksum?: string;
  headRevisionId?: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
  webViewLink?: string;
  contentRestrictions?: { readOnly?: boolean; ownerRestricted?: boolean }[];
  capabilities?: { canModifyOwnerContentRestriction?: boolean };
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  appProperties?: Record<string, string>;
  mimeType?: string;
}

const user = (u?: { displayName?: string; emailAddress?: string }): DriveUser | undefined => (u ? { name: u.displayName, email: u.emailAddress } : undefined);

function toFile(r: RawFile): DriveFile {
  const restriction = r.contentRestrictions?.find((c) => c.readOnly);
  return {
    id: r.id,
    name: r.name,
    md5Checksum: r.md5Checksum,
    headRevisionId: r.headRevisionId,
    size: r.size ? Number(r.size) : undefined,
    trashed: !!r.trashed,
    parents: r.parents ?? [],
    webViewLink: r.webViewLink,
    locked: !!restriction,
    ownerRestricted: !!restriction?.ownerRestricted,
    canModifyOwnerContentRestriction: !!r.capabilities?.canModifyOwnerContentRestriction,
    lastModifyingUser: user(r.lastModifyingUser),
    appProperties: r.appProperties,
  };
}

const lockBody = (locked: boolean, reason?: string) => ({
  contentRestrictions: [locked ? { readOnly: true, ownerRestricted: true, reason } : { readOnly: false }],
});

/**
 * Drive API v3 com `fetch` (sem o `googleapis`, que é pesado). Sempre com
 * `supportsAllDrives=true`: a pasta pode estar num drive compartilhado da pessoa.
 * Nunca loga tokens.
 */
export class GoogleDrive implements DriveProvider {
  readonly kind = 'google' as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(token: string, url: string, init: RequestInit = {}, allow404 = false): Promise<T | null> {
    const u = new URL(url);
    u.searchParams.set('supportsAllDrives', 'true');
    const res = await this.fetchImpl(u, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      let message = `Drive ${res.status}`;
      let reason = '';
      try {
        const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
        message = body.error?.message ?? message;
        reason = body.error?.errors?.[0]?.reason ?? '';
      } catch {
        /* sem corpo */
      }
      if (res.status === 401) throw new DriveError('invalid_grant', message, 401);
      if (res.status === 404) throw new DriveError('not_found', message, 404);
      if (res.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') throw new DriveError('rate_limited', message, res.status);
      if (res.status >= 500) throw new DriveError('server', message, res.status);
      if (res.status === 403 && /restrict/i.test(message + reason)) throw new DriveError('restricted', message, 403);
      if (res.status === 403) throw new DriveError('forbidden', message, 403);
      throw new DriveError('bad_request', message, res.status);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async about(token: string) {
    const r = await this.call<{ user: { displayName?: string; emailAddress?: string } }>(token, `${API}/about?fields=user(displayName,emailAddress)`);
    return user(r?.user) ?? {};
  }

  async getFolder(token: string, folderId: string): Promise<DriveFolder> {
    const r = await this.call<RawFile & { capabilities?: { canAddChildren?: boolean } }>(token, `${API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,parents,driveId,capabilities(canAddChildren)`);
    const names = [r!.name];
    let parent = r!.parents?.[0];
    for (let i = 0; parent && i < 4; i++) {
      const p = await this.call<RawFile>(token, `${API}/files/${encodeURIComponent(parent)}?fields=id,name,parents`, {}, true).catch(() => null);
      if (!p) break;
      names.unshift(p.name);
      parent = p.parents?.[0];
    }
    return {
      id: r!.id,
      name: r!.name,
      isFolder: r!.mimeType === 'application/vnd.google-apps.folder',
      canAddChildren: !!r!.capabilities?.canAddChildren,
      path: names.join(' / '),
    };
  }

  async getFile(token: string, fileId: string) {
    const r = await this.call<RawFile>(token, `${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, {}, true);
    return r ? toFile(r) : null;
  }

  private async upload(token: string, method: 'POST' | 'PATCH', path: string, metadata: Record<string, unknown>, bytes: Uint8Array): Promise<DriveFile> {
    if (bytes.byteLength > RESUMABLE_OVER) {
      const u = new URL(`${UPLOAD}/files${path}?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`);
      const start = await this.fetchImpl(u, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': DOCX_MIME, 'x-upload-content-length': String(bytes.byteLength) },
        body: JSON.stringify(metadata),
      });
      if (!start.ok) throw new DriveError(start.status >= 500 ? 'server' : start.status === 429 ? 'rate_limited' : 'bad_request', `upload ${start.status}`, start.status);
      const location = start.headers.get('location')!;
      const r = await this.fetchImpl(location, { method: 'PUT', headers: { 'content-type': DOCX_MIME }, body: bytes as BodyInit });
      if (!r.ok) throw new DriveError(r.status >= 500 ? 'server' : r.status === 429 ? 'rate_limited' : 'bad_request', `upload ${r.status}`, r.status);
      return toFile((await r.json()) as RawFile);
    }
    const boundary = `erd${Math.random().toString(36).slice(2)}`;
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
    body.set(head, 0);
    body.set(bytes, head.byteLength);
    body.set(tail, head.byteLength + bytes.byteLength);
    const r = await this.call<RawFile>(token, `${UPLOAD}/files${path}?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method,
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: body as BodyInit,
    });
    return toFile(r!);
  }

  createFile(token: string, f: NewFile) {
    // o .docx fica como .docx (sem converter para Google Docs) e nasce bloqueado
    return this.upload(
      token,
      'POST',
      '',
      {
        name: f.name,
        parents: [f.folderId],
        mimeType: DOCX_MIME,
        appProperties: f.appProperties,
        description: f.description,
        writersCanShare: false,
        ...lockBody(true, f.lockReason),
      },
      f.bytes,
    );
  }

  updateContent(token: string, fileId: string, bytes: Uint8Array, name?: string) {
    return this.upload(token, 'PATCH', `/${encodeURIComponent(fileId)}`, name ? { name } : {}, bytes);
  }

  async setLock(token: string, fileId: string, locked: boolean, reason?: string) {
    const r = await this.call<RawFile>(token, `${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lockBody(locked, reason)),
    });
    return toFile(r!);
  }

  async move(token: string, fileId: string, to: string, from: string[]) {
    const u = `${API}/files/${encodeURIComponent(fileId)}?addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(from.join(','))}&fields=${FILE_FIELDS}`;
    const r = await this.call<RawFile>(token, u, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    return toFile(r!);
  }

  async listRevisions(token: string, fileId: string): Promise<DriveRevision[]> {
    const r = await this.call<{ revisions?: { id: string; modifiedTime?: string; lastModifyingUser?: { displayName?: string; emailAddress?: string } }[] }>(
      token,
      `${API}/files/${encodeURIComponent(fileId)}/revisions?fields=revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))&pageSize=200`,
    );
    return (r?.revisions ?? []).map((x) => ({ id: x.id, modifiedTime: x.modifiedTime, lastModifyingUser: user(x.lastModifyingUser) }));
  }

  async deleteRevision(token: string, fileId: string, revisionId: string) {
    await this.call(token, `${API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { method: 'DELETE' });
  }

  async deleteFile(token: string, fileId: string) {
    await this.call(token, `${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, true);
  }

  async findAppFiles(token: string, folderId: string, canvasId: string) {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `'${esc(folderId)}' in parents and appProperties has { key='erdCanvasId' and value='${esc(canvasId)}' }`;
    const r = await this.call<{ files?: RawFile[] }>(token, `${API}/files?q=${encodeURIComponent(q)}&includeItemsFromAllDrives=true&fields=files(${FILE_FIELDS})&pageSize=100`);
    return (r?.files ?? []).map(toFile);
  }
}
