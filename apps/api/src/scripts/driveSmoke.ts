// `pnpm drive:smoke` (drive-docx-plan §10, fase 0, e §11, contrato em staging): confirma no
// Google Drive real o comportamento que o app assume, com duas contas de teste.
//
//   DRIVE_SMOKE_OWNER_TOKEN   token de acesso (escopo drive.file) da conta dona da pasta
//   DRIVE_SMOKE_EDITOR_TOKEN  token de outra conta com acesso de Editor à pasta A
//   DRIVE_SMOKE_FOLDER_A/B    duas pastas da conta dona (escolhidas pelo Picker do app, para o drive.file enxergar)
//
// O item (f), "o Picker concede acesso à pasta", é manual: escolha as pastas pelo app antes.
// Não roda no CI (precisa de credenciais reais).
import { buildDataDictionary } from '@erd/docx';
import { GoogleDrive } from '../drive/google';
import { DRIVE_FILE_DESCRIPTION, DRIVE_LOCK_REASON, DriveError } from '../drive/provider';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`defina ${k}`);
    process.exit(2);
  }
  return v;
};
const owner = need('DRIVE_SMOKE_OWNER_TOKEN');
const editor = need('DRIVE_SMOKE_EDITOR_TOKEN');
const folderA = need('DRIVE_SMOKE_FOLDER_A');
const folderB = need('DRIVE_SMOKE_FOLDER_B');
const g = new GoogleDrive();
const results: { item: string; ok: boolean; note?: string }[] = [];
const check = async (item: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    results.push({ item, ok: true, note: note || undefined });
  } catch (e) {
    results.push({ item, ok: false, note: e instanceof Error ? e.message : String(e) });
  }
};
const expectDenied = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DriveError && (e.code === 'forbidden' || e.code === 'restricted' || e.code === 'not_found')) return;
    throw e;
  }
  throw new Error('a operação deveria ter sido recusada');
};

const doc = async (v: number) =>
  (await buildDataDictionary({ schema: { tables: [], enums: [], relationships: [] }, meta: {}, notes: [] }, { projectName: 'Smoke', version: v, publishedAt: new Date() })).bytes;

let fileId = '';
await check('(a) criar já bloqueado (contentRestrictions + ownerRestricted)', async () => {
  const f = await g.createFile(owner, {
    name: `erd-smoke-${Date.now()}.docx`,
    folderId: folderA,
    bytes: await doc(1),
    appProperties: { erdCanvasId: 'smoke', erdProjectId: 'smoke' },
    description: DRIVE_FILE_DESCRIPTION,
    lockReason: DRIVE_LOCK_REASON,
  });
  fileId = f.id;
  if (!f.locked || !f.ownerRestricted) throw new Error(`bloqueio não aplicado: ${JSON.stringify({ locked: f.locked, ownerRestricted: f.ownerRestricted })}`);
  if (!f.canModifyOwnerContentRestriction) throw new Error('o dono não pode mudar o bloqueio');
});
await check('(b) outra conta (Editor da pasta) não edita nem desbloqueia', async () => {
  await expectDenied(g.updateContent(editor, fileId, await doc(2)));
  await expectDenied(g.setLock(editor, fileId, false));
});
await check('(c) dono: desbloquear → enviar → bloquear de novo', async () => {
  await g.setLock(owner, fileId, false);
  const up = await g.updateContent(owner, fileId, await doc(2));
  const f = await g.setLock(owner, fileId, true, DRIVE_LOCK_REASON);
  if (!f.locked) throw new Error('não voltou a bloquear');
  return `md5 ${up.md5Checksum}`;
});
await check('(d) apagar revisões antigas de um arquivo binário', async () => {
  const head = (await g.getFile(owner, fileId))!.headRevisionId;
  const revs = await g.listRevisions(owner, fileId);
  for (const r of revs) if (r.id !== head) await g.deleteRevision(owner, fileId, r.id);
  const left = await g.listRevisions(owner, fileId);
  if (left.length !== 1) throw new Error(`sobraram ${left.length} revisões`);
  return `${revs.length} → 1`;
});
let moved = '';
await check('troca de pasta: criar na B e excluir definitivamente na A', async () => {
  const f = await g.createFile(owner, {
    name: `erd-smoke-b-${Date.now()}.docx`,
    folderId: folderB,
    bytes: await doc(2),
    appProperties: { erdCanvasId: 'smoke', erdProjectId: 'smoke' },
    description: DRIVE_FILE_DESCRIPTION,
    lockReason: DRIVE_LOCK_REASON,
  });
  moved = f.id;
});
await check('(e) files.delete permanente de um arquivo bloqueado', async () => {
  let note = 'sem desbloquear';
  try {
    await g.deleteFile(owner, fileId);
  } catch (e) {
    if (!(e instanceof DriveError) || e.code !== 'restricted') throw e;
    await g.setLock(owner, fileId, false);
    await g.deleteFile(owner, fileId);
    note = 'precisou desbloquear antes';
  }
  if (await g.getFile(owner, fileId)) throw new Error('o arquivo continua existindo');
  const left = await g.findAppFiles(owner, folderA, 'smoke');
  if (left.length) throw new Error(`sobrou arquivo do app na pasta A: ${left.map((x) => x.id).join(', ')}`);
  return note;
});
if (moved) await g.deleteFile(owner, moved).catch(() => g.setLock(owner, moved, false).then(() => g.deleteFile(owner, moved)));

for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.item}${r.note ? ` — ${r.note}` : ''}`);
console.log('(f) o Picker concede acesso à pasta: confira manualmente escolhendo a pasta pelo app.');
process.exit(results.every((r) => r.ok) ? 0 : 1);
