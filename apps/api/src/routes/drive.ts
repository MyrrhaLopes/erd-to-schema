import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { and, asc, auditLog, canvases, canvasVersions, desc, driveBindings, drivePendingDeletions, drivePublications, eq, isNull, lt, users } from '@erd/db';
import { DriveFolderZ, DriveSettingsZ, PublishZ, type DriveBinding, type DriveConfig, type DriveProject, type DrivePublication } from '@erd/contracts';
import { buildDataDictionary, buildOutline, contentHash, diffProjects } from '@erd/docx';
import { canvasAccess, projectAccess, requireCan, requireUser, type AppEnv, type Deps } from '../context';
import { driveProviderKind } from '../env';
import { stateToProject, type Binding, type DriveService } from '../drive/service';
import { DriveError } from '../drive/provider';
import type { FakeDrive } from '../drive/fake';

const requireDrive = (deps: Deps): DriveService => {
  if (!deps.drive) throw new HTTPException(404, { message: 'O Google Drive não está configurado neste servidor' });
  return deps.drive;
};

/** E-mail e nome da conta Google conectada (cache de 5 min: a tela de configurações não chama o Google a cada abertura) */
const accountCache = new Map<string, { at: number; email: string | null; name: string | null }>();

async function readState(deps: Deps, canvasId: string) {
  const state = await deps.writer.read(canvasId);
  if (!state) throw new HTTPException(409, { message: 'O canvas ainda está vazio' });
  return state;
}

/** Último `published` de um canvas, com quem publicou */
async function lastPublished(deps: Deps, canvasId: string) {
  const [r] = await deps.db
    .select({ version: drivePublications.version, at: drivePublications.createdAt, by: users.name, canvasVersionId: drivePublications.canvasVersionId })
    .from(drivePublications)
    .leftJoin(users, eq(users.id, drivePublications.requestedBy))
    .where(and(eq(drivePublications.canvasId, canvasId), eq(drivePublications.action, 'published')))
    .orderBy(desc(drivePublications.createdAt))
    .limit(1);
  return r ?? null;
}

async function bindingDto(deps: Deps, b: Binding, canvasName: string): Promise<DriveBinding> {
  const last = await lastPublished(deps, b.canvasId);
  const [u] = b.connectedUserId ? await deps.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, b.connectedUserId)) : [];
  const pend = await deps.db.select().from(drivePendingDeletions).where(eq(drivePendingDeletions.canvasId, b.canvasId));
  return {
    canvasId: b.canvasId,
    canvasName,
    folderId: b.folderId,
    folderName: b.folderName,
    folderPath: b.folderPath,
    fileId: b.fileId,
    fileName: b.fileName,
    webViewLink: b.webViewLink,
    lastVersion: b.lastVersion,
    lastContentHash: b.lastContentHash,
    lastPublishedAt: last?.at.toISOString() ?? null,
    lastPublishedBy: last?.by ?? null,
    lock: (b.lock as DriveBinding['lock']) ?? 'none',
    status: b.status as DriveBinding['status'],
    anomaly: b.anomaly,
    autoPublish: b.autoPublish,
    connectedUser: u ?? null,
    pendingDeletions: pend.map((p) => ({
      fileId: p.fileId,
      folderName: p.folderName,
      attempts: p.attempts,
      lastError: p.lastError,
      manual: !!p.gaveUpAt,
      link: `https://drive.google.com/file/d/${encodeURIComponent(p.fileId)}/view`,
    })),
  };
}

/**
 * Pede uma publicação (§3.2): confere o hash revisado, cria a versão protegida do canvas e
 * enfileira o job. Também usada pela publicação automática ao salvar uma versão nomeada.
 */
export async function requestPublish(deps: Deps, canvasId: string, projectName: string, userId: string, o: { reviewedHash?: string; revertedFrom?: number }) {
  const drive = requireDrive(deps);
  const b = await drive.binding(canvasId);
  if (!b) throw new HTTPException(409, { message: 'Escolha uma pasta do Google Drive antes de publicar' });
  if (b.status === 'paused') throw new HTTPException(409, { message: 'O Google Drive foi desconectado deste canvas' });
  if (b.status === 'needs_folder') throw new HTTPException(409, { message: 'O dono precisa escolher a pasta do documento de novo' });
  const state = await readState(deps, canvasId);
  const hash = await contentHash(stateToProject(state), projectName);
  if (o.reviewedHash && hash !== o.reviewedHash) throw new HTTPException(409, { message: 'O modelo mudou desde a revisão. Revise de novo antes de publicar.' });
  if (hash === b.lastContentHash && b.fileId) {
    await deps.db.insert(drivePublications).values({ id: `dp_${nanoid(12)}`, canvasId, action: 'unchanged', requestedBy: userId, version: null, contentHash: hash });
    await deps.events.broadcast(canvasId, { type: 'drive', event: 'unchanged', version: b.lastVersion });
    return { status: 'unchanged' as const, version: b.lastVersion, jobId: null };
  }
  const versionId = await deps.store.createVersion(canvasId, 'Publicação no Drive (em andamento)', state, userId, true);
  const jobId = await drive.jobs.send({ type: 'publish', canvasId, canvasVersionId: versionId, requestedBy: userId, revertedFrom: o.revertedFrom, contentHash: hash }, canvasId);
  return { status: 'queued' as const, version: b.lastVersion + 1, jobId };
}

/** `/api/drive` */
export function driveConfigRoutes(deps: Deps) {
  return new Hono<AppEnv>().get('/config', (c) => {
    requireUser(c.get('user'));
    const kind = deps.drive?.provider.kind ?? driveProviderKind(deps.env);
    const out: DriveConfig = {
      enabled: !!deps.drive && !!kind,
      provider: kind ?? 'google',
      pickerApiKey: kind === 'google' ? (deps.env.GOOGLE_PICKER_API_KEY ?? null) : null,
      appId: kind === 'google' ? (deps.env.GOOGLE_PROJECT_NUMBER ?? null) : null,
      clientId: kind === 'google' ? (deps.env.GOOGLE_CLIENT_ID ?? null) : null,
    };
    return c.json(out);
  });
}

/** `/api/projects/:id/drive...` */
export function projectDriveRoutes(deps: Deps) {
  const { db } = deps;
  return (
    new Hono<AppEnv>()
      .get('/:id/drive', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await projectAccess(db, c.req.param('id'), user.id);
        const [owner] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, a.project.ownerId));
        const drive = deps.drive;
        const kind = drive?.provider.kind ?? null;
        let account: DriveProject['account'] = { connected: false, email: null, name: null };
        if (drive && (await drive.tokens.connected(a.project.ownerId))) {
          const cached = accountCache.get(a.project.ownerId);
          if (cached && Date.now() - cached.at < 300_000) account = { connected: true, email: cached.email, name: cached.name };
          else {
            try {
              const who = await drive.provider.about(await drive.tokens.get(a.project.ownerId));
              account = { connected: true, email: who.email ?? null, name: who.name ?? null };
              accountCache.set(a.project.ownerId, { at: Date.now(), email: account.email, name: account.name });
            } catch {
              account = { connected: false, email: null, name: null };
            }
          }
        }
        const rows = drive
          ? await db
              .select({ b: driveBindings, name: canvases.name })
              .from(driveBindings)
              .innerJoin(canvases, eq(canvases.id, driveBindings.canvasId))
              .where(and(eq(driveBindings.projectId, a.project.id), isNull(canvases.deletedAt)))
              .orderBy(asc(canvases.position))
          : [];
        const out: DriveProject = {
          enabled: !!drive && !!kind,
          provider: kind ?? 'google',
          isOwner: a.role === 'owner',
          owner: owner ?? { id: a.project.ownerId, name: '?' },
          account,
          bindings: await Promise.all(rows.map((r) => bindingDto(deps, r.b, r.name))),
        };
        return c.json(out);
      })

      /** Token curto do dono para o Google Picker (com `drive.file`, é o Picker que dá acesso à pasta) */
      .get('/:id/drive/picker-token', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await projectAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'driveConfigure');
        const drive = requireDrive(deps);
        let accessToken: string;
        try {
          accessToken = await drive.tokens.get(user.id);
        } catch {
          throw new HTTPException(409, { message: 'Conecte o seu Google Drive primeiro' });
        }
        const folders = drive.provider.kind === 'fake' ? (drive.provider as FakeDrive).listFolders(user.id) : [];
        return c.json({ accessToken, folders }, 200, { 'Cache-Control': 'no-store' });
      })

      /** Modo fake (E2E/dev): "conectar" sem OAuth */
      .post('/:id/drive/fake-connect', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await projectAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'driveConfigure');
        const drive = requireDrive(deps);
        if (drive.provider.kind !== 'fake') throw new HTTPException(404, { message: 'Não encontrado' });
        await drive.tokens.connectFake(user.id);
        accountCache.delete(user.id);
        return c.json({ ok: true });
      })
  );
}

/** `/api/canvases/:id/drive...` e `/api/canvases/:id/docx` */
export function canvasDriveRoutes(deps: Deps) {
  const { db } = deps;
  return (
    new Hono<AppEnv>()
      /** Gera e baixa o .docx na hora, sem Drive (§9.1) */
      .get('/:id/docx', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'export');
        const pd = stateToProject(await readState(deps, a.canvas.id));
        const b = deps.drive ? await deps.drive.binding(a.canvas.id) : null;
        const hash = await contentHash(pd, a.project.name);
        const version = b ? (b.lastContentHash === hash ? b.lastVersion : b.lastVersion + 1) : 1;
        const { bytes, review } = await buildDataDictionary(pd, { projectName: a.project.name, version, publishedAt: new Date() });
        return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${review.fileName.replace(/[^\w.-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(review.fileName)}`,
          'Cache-Control': 'no-store',
        });
      })

      /** Tela de revisão (§3.1): o resumo do gerador, o hash e o que mudou desde a última publicação */
      .get('/:id/drive/review', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        const pd = stateToProject(await readState(deps, a.canvas.id));
        const b = deps.drive ? await deps.drive.binding(a.canvas.id) : null;
        const hash = await contentHash(pd, a.project.name);
        const nextVersion = (b?.lastVersion ?? 0) + 1;
        const { review } = buildOutline(pd, { projectName: a.project.name, version: nextVersion, publishedAt: new Date() });
        const last = await lastPublished(deps, a.canvas.id);
        let prev: ReturnType<typeof stateToProject> | null = null;
        if (last?.canvasVersionId) {
          const [v] = await db.select({ state: canvasVersions.state }).from(canvasVersions).where(eq(canvasVersions.id, last.canvasVersionId));
          if (v) prev = stateToProject(v.state);
        }
        return c.json({
          review,
          hash,
          nextVersion,
          unchanged: !!b?.fileId && b.lastContentHash === hash,
          lastPublished: last ? { version: last.version, at: last.at.toISOString(), by: last.by } : null,
          diff: last ? diffProjects(prev, pd) : null,
        });
      })

      .post('/:id/drive/publish', zValidator('json', PublishZ), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'drivePublish');
        const body = c.req.valid('json');
        const r = await requestPublish(deps, a.canvas.id, a.project.name, user.id, body);
        return c.json(r, r.status === 'queued' ? 202 : 200);
      })

      .get('/:id/drive/jobs/:jobId', async (c) => {
        const user = requireUser(c.get('user'));
        await canvasAccess(db, c.req.param('id'), user.id);
        const drive = requireDrive(deps);
        return c.json({ state: await drive.jobs.state(c.req.param('jobId')) });
      })

      /** Histórico (§7): só metadados, do mais novo para o mais antigo */
      .get(
        '/:id/drive/publications',
        zValidator('query', z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })),
        async (c) => {
          const user = requireUser(c.get('user'));
          const a = await canvasAccess(db, c.req.param('id'), user.id);
          const { before, limit } = c.req.valid('query');
          const rows = await db
            .select({ p: drivePublications, byName: users.name })
            .from(drivePublications)
            .leftJoin(users, eq(users.id, drivePublications.requestedBy))
            .where(and(eq(drivePublications.canvasId, a.canvas.id), before ? lt(drivePublications.createdAt, new Date(before)) : undefined))
            .orderBy(desc(drivePublications.createdAt))
            .limit(limit);
          const out: DrivePublication[] = rows.map(({ p, byName }) => ({
            id: p.id,
            action: p.action as DrivePublication['action'],
            version: p.version,
            revertedFrom: p.revertedFrom,
            canvasVersionId: p.canvasVersionId,
            requestedBy: p.requestedBy ? { id: p.requestedBy, name: byName ?? '' } : null,
            folderName: p.folderName,
            previousFolderName: p.previousFolderName,
            oldFileDeletedAt: p.oldFileDeletedAt?.toISOString() ?? null,
            sizeBytes: p.sizeBytes,
            externalActor: p.externalActor ?? null,
            error: p.error,
            createdAt: p.createdAt.toISOString(),
          }));
          return c.json(out);
        },
      )

      /** Primeira escolha da pasta (cria o vínculo) ou troca de pasta (§5), só o dono */
      .put('/:id/drive/folder', zValidator('json', DriveFolderZ), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'driveConfigure');
        const drive = requireDrive(deps);
        const { folderId } = c.req.valid('json');
        let token: string;
        try {
          token = await drive.tokens.get(user.id);
        } catch {
          throw new HTTPException(409, { message: 'Conecte o seu Google Drive primeiro' });
        }
        let folder;
        try {
          folder = await drive.provider.getFolder(token, folderId);
        } catch (e) {
          if (e instanceof DriveError && (e.code === 'not_found' || e.code === 'forbidden'))
            throw new HTTPException(422, { message: 'Pasta não encontrada ou sem acesso. Escolha a pasta pelo seletor do Google.' });
          throw e;
        }
        if (!folder.isFolder) throw new HTTPException(422, { message: 'O item escolhido não é uma pasta' });
        if (!folder.canAddChildren) throw new HTTPException(422, { message: 'Você não pode criar arquivos nesta pasta' });
        const b = await drive.binding(a.canvas.id);
        if (!b) {
          await db.insert(driveBindings).values({
            canvasId: a.canvas.id,
            projectId: a.project.id,
            connectedUserId: user.id,
            folderId: folder.id,
            folderName: folder.name,
            folderPath: folder.path,
          });
          await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'drive.connected', payload: { canvasId: a.canvas.id, folder: folder.name } });
          return c.json({ status: 'created' as const, jobId: null }, 201);
        }
        if (b.folderId === folder.id && b.connectedUserId === user.id && b.status !== 'paused' && b.status !== 'needs_folder')
          return c.json({ status: 'unchanged' as const, jobId: null }, 200);
        if (b.status === 'paused' || !b.fileId) {
          await db
            .update(driveBindings)
            .set({ folderId: folder.id, folderName: folder.name, folderPath: folder.path, connectedUserId: user.id, status: 'active', anomaly: null, updatedAt: new Date() })
            .where(eq(driveBindings.canvasId, a.canvas.id));
          return c.json({ status: 'updated' as const, jobId: null }, 200);
        }
        const jobId = await drive.jobs.send(
          { type: 'relocate', canvasId: a.canvas.id, folderId: folder.id, folderName: folder.name, folderPath: folder.path, requestedBy: user.id, tokenUserId: user.id },
          a.canvas.id,
        );
        return c.json({ status: 'queued' as const, jobId }, 202);
      })

      .put('/:id/drive/settings', zValidator('json', DriveSettingsZ), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'driveConfigure');
        await db
          .update(driveBindings)
          .set({ autoPublish: c.req.valid('json').autoPublish, updatedAt: new Date() })
          .where(eq(driveBindings.canvasId, a.canvas.id));
        return c.json({ ok: true });
      })

      /** Desconectar: exclui definitivamente o arquivo (padrão) ou deixa congelado no Drive */
      .delete('/:id/drive', zValidator('query', z.object({ deleteFile: z.enum(['true', 'false']).default('true') })), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'driveConfigure');
        const drive = requireDrive(deps);
        if (!(await drive.binding(a.canvas.id))) throw new HTTPException(404, { message: 'Este canvas não está no Drive' });
        const jobId = await drive.jobs.send(
          { type: 'disconnect', canvasId: a.canvas.id, deleteFile: c.req.valid('query').deleteFile === 'true', requestedBy: user.id },
          a.canvas.id,
        );
        return c.json({ jobId }, 202);
      })
  );
}
