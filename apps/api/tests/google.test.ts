import { describe, expect, it } from 'vitest';
import { GoogleDrive } from '../src/drive/google';
import { DriveError } from '../src/drive/provider';

type Call = { url: URL; init: RequestInit };

function stub(responses: ((c: Call) => Response)[]) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const c = { url: new URL(String(input)), init };
    calls.push(c);
    const r = responses.shift();
    if (!r) throw new Error('chamada inesperada ' + c.url);
    return r(c);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const raw = {
  id: 'f1',
  name: 'Doc.docx',
  md5Checksum: 'abc',
  headRevisionId: 'r1',
  parents: ['p'],
  contentRestrictions: [{ readOnly: true, ownerRestricted: true }],
  capabilities: { canModifyOwnerContentRestriction: true },
};

describe('GoogleDrive (Drive API v3 com fetch)', () => {
  it('cria o .docx já bloqueado, em multipart, com supportsAllDrives', async () => {
    const { f, calls } = stub([() => json(raw)]);
    const out = await new GoogleDrive(f).createFile('tok', {
      name: 'Doc.docx',
      folderId: 'p',
      bytes: new Uint8Array([1, 2, 3]),
      appProperties: { erdCanvasId: 'c' },
      description: 'd',
      lockReason: 'r',
    });
    expect(out).toMatchObject({ id: 'f1', locked: true, ownerRestricted: true, canModifyOwnerContentRestriction: true });
    const c = calls[0];
    expect(c.url.pathname).toBe('/upload/drive/v3/files');
    expect(c.url.searchParams.get('uploadType')).toBe('multipart');
    expect(c.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = new TextDecoder().decode(c.init.body as Uint8Array);
    const meta = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0]);
    expect(meta).toMatchObject({
      name: 'Doc.docx',
      parents: ['p'],
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      appProperties: { erdCanvasId: 'c' },
      writersCanShare: false,
      contentRestrictions: [{ readOnly: true, ownerRestricted: true, reason: 'r' }],
    });
  });

  it('acima de 5 MB usa upload resumable', async () => {
    const { f, calls } = stub([() => new Response(null, { status: 200, headers: { location: 'https://upload.test/session' } }), () => json(raw)]);
    await new GoogleDrive(f).updateContent('tok', 'f1', new Uint8Array(6 * 1024 * 1024));
    expect(calls[0].url.searchParams.get('uploadType')).toBe('resumable');
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[1].url.href).toBe('https://upload.test/session');
    expect(calls[1].init.method).toBe('PUT');
  });

  it('erros viram códigos: 404 → null no getFile, 429 → retentável, 403 com restrição, 401 → invalid_grant', async () => {
    const err =
      (status: number, reason = '', message = 'x') =>
      () =>
        json({ error: { message, errors: [{ reason }] } }, status);
    const { f } = stub([
      err(404),
      err(429),
      err(403, 'fileWriterTeamDriveMoveInDisabled', 'The file has a content restriction'),
      err(401),
      err(503),
      err(403, 'insufficientFilePermissions'),
    ]);
    const g = new GoogleDrive(f);
    expect(await g.getFile('t', 'x')).toBeNull();
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        await g.setLock('t', 'x', false);
      } catch (e) {
        codes.push((e as DriveError).code + ((e as DriveError).retryable ? '!' : ''));
      }
    }
    expect(codes).toEqual(['rate_limited!', 'restricted', 'invalid_grant', 'server!', 'forbidden']);
  });

  it('procura os arquivos do app numa pasta (inclusive na lixeira) pelo appProperties', async () => {
    const { f, calls } = stub([() => json({ files: [{ ...raw, trashed: true }] })]);
    const out = await new GoogleDrive(f).findAppFiles('t', "pa'sta", 'c1');
    expect(out[0].trashed).toBe(true);
    const q = calls[0].url.searchParams.get('q')!;
    expect(q).toBe("'pa\\'sta' in parents and appProperties has { key='erdCanvasId' and value='c1' }");
    expect(q).not.toMatch(/trashed/);
  });
});
