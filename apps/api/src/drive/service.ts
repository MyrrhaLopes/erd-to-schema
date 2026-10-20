import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import { and, auditLog, canvases, canvasVersions, desc, driveBindings, drivePendingDeletions, drivePublications, eq, isNull, lte, ne, projects, users, type Db } from '@erd/db';
import { projectDoc, type ProjectDoc } from '@erd/crdt';
import { buildDataDictionary, contentHash } from '@erd/docx';
import type { DriveAction } from '@erd/contracts';
import type { CanvasWriter, Events } from '../context';
import type { Logger } from '../log';
import type { JobContext, JobQueue } from '../queue';
import { DRIVE_FILE_DESCRIPTION, DRIVE_LOCK_REASON, DriveError, type DriveFile, type DriveProvider } from './provider';
import type { DriveTokens } from './token';

export type DriveJob =
  | { type: 'publish'; canvasId: string; canvasVersionId: string; requestedBy: string | null; revertedFrom?: number; contentHash: string }
  | { type: 'relocate'; canvasId: string; folderId: string; folderName: string; folderPath: string | null; requestedBy: string; tokenUserId: string }
  | { type: 'cleanup'; canvasId: string; fileId: string }
  | { type: 'audit'; canvasId: string }
  | { type: 'disconnect'; canvasId: string; deleteFile: boolean; requestedBy: string };

export type Binding = typeof driveBindings.$inferSelect;

export interface DriveAlert {
  projectId: string;
  canvasId: string;
  title: string;
  message: string;
}

export interface DriveServiceDeps {
  db: Db;
  provider: DriveProvider;
  tokens: DriveTokens;
  events: Pick<Events, 'broadcast'>;
  writer: Pick<CanvasWriter, 'read'>;
  log: Logger;
  /** Sininho + e-mail para o dono do projeto (respeita as preferências) */
  alert: (a: DriveAlert) => Promise<void>;
}

export const DRIVE_METRICS = {
  publish: { published: 0, unchanged: 0, failed: 0 },
  publishSecondsTotal: 0,
  publishCount: 0,
  externalEdits: 0,
};

/** Limite de tentativas da exclusão definitiva do arquivo antigo (§5, passo 6) */
const CLEANUP_WINDOW_MS = 24 * 3600_000;

const errText = (e: unknown) => (e instanceof DriveError ? e.message : e instanceof Error ? e.message : String(e)).slice(0, 500);

export function stateToProject(state: Uint8Array): ProjectDoc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const pd = projectDoc(doc);
  doc.destroy();
  return pd;
}

/**
 * O documento Word no Drive (drive-docx-plan §3–§8). Toda operação no Drive roda num job
 * (`DriveJob`), em série por canvas, sempre com o token de quem é dono do arquivo.
 */
export class DriveService {
  jobs!: JobQueue<DriveJob>;
  constructor(private readonly d: DriveServiceDeps) {}

  get provider() {
    return this.d.provider;
  }
  get tokens() {
    return this.d.tokens;
  }

  /** Handler da fila: decide retentar (429/5xx) ou registrar a falha definitiva */
  run = async (job: DriveJob, ctx: JobContext) => {
    switch (job.type) {
      case 'publish':
        return this.publish(job, ctx);
      case 'relocate':
        return this.relocate(job, ctx);
      case 'cleanup':
        return this.cleanup(job.fileId);
      case 'audit':
        return this.audit(job.canvasId);
      case 'disconnect':
        return this.disconnect(job);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Leitura                                                              */
  /* ------------------------------------------------------------------ */

  async binding(canvasId: string): Promise<Binding | null> {
    const [b] = await this.d.db.select().from(driveBindings).where(eq(driveBindings.canvasId, canvasId));
    return b ?? null;
  }

  async projectOf(canvasId: string) {
    const [r] = await this.d.db
      .select({ projectId: projects.id, name: projects.name, ownerId: projects.ownerId })
      .from(canvases)
      .innerJoin(projects, eq(projects.id, canvases.projectId))
      .where(eq(canvases.id, canvasId));
    return r ?? null;
  }

  /** Hash do conteúdo do documento a partir de um estado do canvas */
  async hashOf(state: Uint8Array, projectName: string) {
    return contentHash(stateToProject(state), projectName);
  }

  /* ------------------------------------------------------------------ */
  /* Registro                                                             */
  /* ------------------------------------------------------------------ */

  private async record(canvasId: string, action: DriveAction, row: Partial<typeof drivePublications.$inferInsert> = {}, db: Db = this.d.db) {
    const id = `dp_${nanoid(12)}`;
    await db.insert(drivePublications).values({ id, canvasId, action, ...row });
    return id;
  }

  private async update(canvasId: string, patch: Partial<typeof driveBindings.$inferInsert>, db: Db = this.d.db) {
    await db
      .update(driveBindings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(driveBindings.canvasId, canvasId));
  }

  private async userName(id: string | null) {
    if (!id) return undefined;
    const [u] = await this.d.db.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name;
  }

  /** Avisa o dono uma vez por anomalia (a auditoria roda a cada 6 h e não deve repetir o aviso) */
  private async anomaly(b: Binding, key: string, title: string, message: string) {
    if (b.anomaly === key) return false;
    await this.update(b.canvasId, { anomaly: key });
    b.anomaly = key;
    const p = await this.projectOf(b.canvasId);
    if (p) await this.d.alert({ projectId: p.projectId, canvasId: b.canvasId, title, message }).catch((err) => this.d.log.warn({ err }, 'falha ao avisar o dono'));
    return true;
  }

  private async token(b: Binding, userId: string | null = b.connectedUserId): Promise<string | null> {
    try {
      if (!userId) throw new DriveError('invalid_grant', 'Ninguém conectado ao Drive');
      return await this.d.tokens.get(userId);
    } catch (e) {
      if (!(e instanceof DriveError) || e.code !== 'invalid_grant') throw e;
      await this.update(b.canvasId, { status: 'needs_reconnect' });
      await this.anomaly(
        b,
        'needs_reconnect',
        'Reconecte o Google Drive',
        'O acesso ao Google Drive expirou ou foi revogado. Conecte o Drive de novo para voltar a publicar o documento.',
      );
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Vigilância (§2.2, §8.2): antes de cada publicação e a cada 6 h       */
  /* ------------------------------------------------------------------ */

  private async inspect(b: Binding, file: DriveFile, token: string, mode: 'publish' | 'audit'): Promise<DriveFile> {
    let f = file;
    if (!f.parents.includes(b.folderId)) {
      f = await this.d.provider.move(token, f.id, b.folderId, f.parents);
      await this.record(b.canvasId, 'moved_externally', { fileId: f.id, folderId: b.folderId, folderName: b.folderName });
      await this.anomaly(b, `moved:${f.id}:${Date.now()}`, 'O documento foi movido no Drive', `O arquivo foi movido para fora da pasta "${b.folderName}" e foi devolvido a ela.`);
    }
    const edited = !!b.lastMd5 && (f.md5Checksum !== b.lastMd5 || (!!b.lastRevisionId && !!f.headRevisionId && f.headRevisionId !== b.lastRevisionId));
    if (edited) {
      const key = `external_edit:${f.headRevisionId ?? f.md5Checksum}`;
      if (b.anomaly !== key) {
        DRIVE_METRICS.externalEdits++;
        const who = f.lastModifyingUser;
        await this.record(b.canvasId, 'external_edit_detected', {
          fileId: f.id,
          driveRevisionId: f.headRevisionId,
          md5: f.md5Checksum,
          externalActor: who ? { ...(who.name ? { name: who.name } : {}), ...(who.email ? { email: who.email } : {}) } : null,
        });
        await this.anomaly(
          b,
          key,
          'O documento foi editado pelo Google Drive',
          `${who?.name ?? who?.email ?? 'Alguém'} editou o documento pelo Google Drive. ${mode === 'publish' ? 'A publicação de agora sobrescreveu a edição.' : 'A próxima publicação vai sobrescrever a edição.'}`,
        );
      }
    }
    if (!f.locked || !f.ownerRestricted) {
      if (mode === 'audit') f = await this.d.provider.setLock(token, f.id, true, DRIVE_LOCK_REASON);
      await this.record(b.canvasId, 'relocked', { fileId: f.id });
      if (mode === 'audit') await this.update(b.canvasId, { lock: 'locked' });
    }
    return f;
  }

  async audit(canvasId: string) {
    const b = await this.binding(canvasId);
    if (!b || !b.fileId || b.status === 'paused') return;
    const token = await this.token(b);
    if (!token) return;
    const file = await this.d.provider.getFile(token, b.fileId);
    if (!file || file.trashed) {
      await this.anomaly(
        b,
        `missing:${b.fileId}`,
        'O documento sumiu do Drive',
        'O arquivo foi apagado ou movido para a lixeira no Google Drive. A próxima publicação cria um novo.',
      );
      return;
    }
    await this.inspect(b, file, token, 'audit');
    if (b.lock === 'pending') {
      await this.d.provider.setLock(token, file.id, true, DRIVE_LOCK_REASON);
      await this.update(canvasId, { lock: 'locked' });
    }
    if (b.status === 'needs_reconnect') await this.update(canvasId, { status: 'active' });
  }

  /* ------------------------------------------------------------------ */
  /* Publicar (§3.2)                                                      */
  /* ------------------------------------------------------------------ */

  private async createLocked(token: string, b: Pick<Binding, 'canvasId' | 'projectId'>, folderId: string, name: string, bytes: Uint8Array) {
    const f = await this.d.provider.createFile(token, {
      name,
      folderId,
      bytes,
      appProperties: { erdCanvasId: b.canvasId, erdProjectId: b.projectId },
      description: DRIVE_FILE_DESCRIPTION,
      lockReason: DRIVE_LOCK_REASON,
    });
    // nunca deixa um arquivo desbloqueado: se o bloqueio não ficou como pedido, desfaz e falha
    if (!f.locked || !f.ownerRestricted || !f.canModifyOwnerContentRestriction) {
      await this.d.provider.deleteFile(token, f.id).catch(() => {});
      throw new DriveError('restricted', 'O Google Drive não aplicou o bloqueio do arquivo; a publicação foi cancelada.');
    }
    return f;
  }

  private async publish(job: Extract<DriveJob, { type: 'publish' }>, ctx: JobContext) {
    const t0 = performance.now();
    const b = await this.binding(job.canvasId);
    const p = await this.projectOf(job.canvasId);
    if (!b || !p || b.status === 'paused') return;
    const fail = async (error: string) => {
      DRIVE_METRICS.publish.failed++;
      await this.record(job.canvasId, 'failed', {
        canvasVersionId: job.canvasVersionId,
        requestedBy: job.requestedBy,
        revertedFrom: job.revertedFrom,
        error,
        folderId: b.folderId,
        folderName: b.folderName,
      });
      // a versão do canvas de uma publicação que não saiu deixa de ser protegida
      await this.d.db
        .update(canvasVersions)
        .set({ protected: false, label: `Publicação não concluída — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` })
        .where(eq(canvasVersions.id, job.canvasVersionId));
      await this.d.events.broadcast(job.canvasId, { type: 'drive', event: 'failed', error, by: await this.userName(job.requestedBy) });
    };
    const [cv] = await this.d.db.select({ state: canvasVersions.state }).from(canvasVersions).where(eq(canvasVersions.id, job.canvasVersionId));
    if (!cv) return fail('A versão do canvas desta publicação não existe mais');
    const token = await this.token(b);
    if (!token) return fail('O acesso ao Google Drive do dono expirou ou foi revogado');

    try {
      const version = b.lastVersion + 1;
      const publishedAt = new Date();
      const pd = stateToProject(cv.state);
      const { bytes, review } = await buildDataDictionary(pd, { projectName: p.name, version, publishedAt });
      let file = b.fileId ? await this.d.provider.getFile(token, b.fileId) : null;
      let recreated = false;
      if (b.fileId && (!file || file.trashed)) {
        // na lixeira: exclui de vez (ninguém restaura uma versão paralela) e cria de novo
        if (file?.trashed) await this.d.provider.deleteFile(token, file.id).catch(() => {});
        file = null;
        recreated = true;
      }
      if (file) file = await this.inspect(b, file, token, 'publish');
      let lock: 'locked' | 'pending' = 'locked';
      if (!file) file = await this.createLocked(token, b, b.folderId, review.fileName, bytes);
      else {
        const id = file.id;
        try {
          if (file.locked) await this.d.provider.setLock(token, id, false);
          file = await this.d.provider.updateContent(token, id, bytes, review.fileName !== file.name ? review.fileName : undefined);
        } finally {
          // o bloqueio volta mesmo se o envio falhar; se nem isso der, o drive.audit repara
          try {
            const locked = await this.d.provider.setLock(token, id, true, DRIVE_LOCK_REASON);
            file = { ...file!, locked: locked.locked, ownerRestricted: locked.ownerRestricted };
          } catch (err) {
            lock = 'pending';
            this.d.log.warn({ err, canvasId: job.canvasId }, 'não foi possível bloquear o documento de novo');
          }
        }
      }
      // a única versão no Drive é a publicada: o "Gerenciar versões" do Drive não vira um caminho paralelo
      try {
        for (const r of await this.d.provider.listRevisions(token, file.id)) if (r.id !== file.headRevisionId) await this.d.provider.deleteRevision(token, file.id, r.id);
      } catch (err) {
        this.d.log.warn({ err, canvasId: job.canvasId }, 'revisões antigas do Drive não foram apagadas');
      }
      const done = file;
      await this.d.db.transaction(async (tx) => {
        await tx
          .update(canvasVersions)
          .set({ label: `Publicação v${version} no Drive${job.revertedFrom ? ` (reversão da v${job.revertedFrom})` : ''}`, protected: true })
          .where(eq(canvasVersions.id, job.canvasVersionId));
        if (recreated)
          await this.record(job.canvasId, 'recreated', { fileId: done.id, previousFileId: b.fileId, folderId: b.folderId, folderName: b.folderName }, tx as unknown as Db);
        await this.record(
          job.canvasId,
          'published',
          {
            version,
            revertedFrom: job.revertedFrom,
            canvasVersionId: job.canvasVersionId,
            requestedBy: job.requestedBy,
            fileId: done.id,
            driveRevisionId: done.headRevisionId,
            md5: done.md5Checksum,
            sizeBytes: bytes.byteLength,
            contentHash: job.contentHash,
            folderId: b.folderId,
            folderName: b.folderName,
          },
          tx as unknown as Db,
        );
        await this.update(
          job.canvasId,
          {
            fileId: done.id,
            fileName: done.name,
            webViewLink: done.webViewLink ?? null,
            lastRevisionId: done.headRevisionId ?? null,
            lastMd5: done.md5Checksum ?? null,
            lastContentHash: job.contentHash,
            lastVersion: version,
            lock,
            status: b.status === 'transfer_pending' ? 'transfer_pending' : 'active',
            anomaly: null,
          },
          tx as unknown as Db,
        );
        await tx
          .insert(auditLog)
          .values({
            projectId: p.projectId,
            actorId: job.requestedBy,
            action: 'drive.published',
            payload: { canvasId: job.canvasId, version, revertedFrom: job.revertedFrom ?? null },
          });
      });
      DRIVE_METRICS.publish.published++;
      DRIVE_METRICS.publishCount++;
      DRIVE_METRICS.publishSecondsTotal += (performance.now() - t0) / 1000;
      await this.d.events.broadcast(job.canvasId, { type: 'drive', event: 'published', version, by: await this.userName(job.requestedBy), link: done.webViewLink });
    } catch (e) {
      if (e instanceof DriveError && e.retryable && ctx.retryCount < ctx.retryLimit) throw e;
      if (e instanceof DriveError && (e.code === 'forbidden' || e.code === 'not_found')) {
        await this.update(job.canvasId, { status: 'needs_folder' });
        await this.anomaly(
          b,
          'needs_folder',
          'Escolha a pasta do documento de novo',
          `Não foi possível gravar na pasta "${b.folderName}" do Google Drive. Escolha a pasta de novo em Configurações do projeto → Documento.`,
        );
      } else if (e instanceof DriveError && e.code === 'invalid_grant') {
        await this.update(job.canvasId, { status: 'needs_reconnect' });
        await this.anomaly(
          b,
          'needs_reconnect',
          'Reconecte o Google Drive',
          'O acesso ao Google Drive expirou ou foi revogado. Conecte o Drive de novo para voltar a publicar o documento.',
        );
      } else if (!(e instanceof DriveError) && ctx.retryCount < ctx.retryLimit) throw e;
      this.d.log.warn({ err: e, canvasId: job.canvasId }, 'publicação no Drive falhou');
      await fail(errText(e));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Trocar a pasta (§5) e transferência (§6)                             */
  /* ------------------------------------------------------------------ */

  private async relocate(job: Extract<DriveJob, { type: 'relocate' }>, ctx: JobContext) {
    const b = await this.binding(job.canvasId);
    const p = await this.projectOf(job.canvasId);
    if (!b || !p) return;
    const sameAccount = b.connectedUserId === job.tokenUserId;
    if (b.folderId === job.folderId && sameAccount && b.fileId) return;
    const prev = { folderId: b.folderId, folderName: b.folderName, fileId: b.fileId, tokenUserId: b.connectedUserId };
    if (!b.fileId) {
      // nada publicado ainda: só aponta o vínculo para a pasta nova
      await this.update(job.canvasId, {
        folderId: job.folderId,
        folderName: job.folderName,
        folderPath: job.folderPath,
        connectedUserId: job.tokenUserId,
        status: 'active',
        anomaly: null,
      });
      await this.record(job.canvasId, 'folder_changed', {
        requestedBy: job.requestedBy,
        folderId: job.folderId,
        folderName: job.folderName,
        previousFolderId: prev.folderId,
        previousFolderName: prev.folderName,
      });
      return;
    }
    const token = await this.token(b, job.tokenUserId);
    if (!token) return;
    try {
      // a mesma versão do canvas da última publicação, sem número novo
      const [last] = await this.d.db
        .select({ canvasVersionId: drivePublications.canvasVersionId, createdAt: drivePublications.createdAt })
        .from(drivePublications)
        .where(and(eq(drivePublications.canvasId, job.canvasId), eq(drivePublications.action, 'published')))
        .orderBy(desc(drivePublications.createdAt))
        .limit(1);
      let state: Uint8Array | null = null;
      if (last?.canvasVersionId) {
        const [v] = await this.d.db.select({ state: canvasVersions.state }).from(canvasVersions).where(eq(canvasVersions.id, last.canvasVersionId));
        state = v?.state ?? null;
      }
      // a versão do canvas sumiu (canvas restaurado de backup, por exemplo): usa o estado atual
      state ??= await this.d.writer.read(job.canvasId);
      if (!state) throw new Error('canvas vazio');
      const { bytes, review } = await buildDataDictionary(stateToProject(state), { projectName: p.name, version: b.lastVersion, publishedAt: last?.createdAt ?? new Date() });
      // 1. cria na pasta nova; se falhar, nada muda
      const f = await this.createLocked(token, b, job.folderId, review.fileName, bytes);
      // 2. numa transação: o vínculo passa para o arquivo novo e o antigo entra na fila de exclusão
      await this.d.db.transaction(async (tx) => {
        await this.update(
          job.canvasId,
          {
            folderId: job.folderId,
            folderName: job.folderName,
            folderPath: job.folderPath,
            fileId: f.id,
            fileName: f.name,
            webViewLink: f.webViewLink ?? null,
            lastRevisionId: f.headRevisionId ?? null,
            lastMd5: f.md5Checksum ?? null,
            connectedUserId: job.tokenUserId,
            lock: 'locked',
            status: 'active',
            anomaly: null,
          },
          tx as unknown as Db,
        );
        await this.record(
          job.canvasId,
          'folder_changed',
          {
            requestedBy: job.requestedBy,
            fileId: f.id,
            md5: f.md5Checksum,
            sizeBytes: bytes.byteLength,
            folderId: job.folderId,
            folderName: job.folderName,
            previousFolderId: prev.folderId,
            previousFolderName: prev.folderName,
            previousFileId: prev.fileId,
          },
          tx as unknown as Db,
        );
        await tx
          .insert(drivePendingDeletions)
          .values({ fileId: prev.fileId!, canvasId: job.canvasId, tokenUserId: prev.tokenUserId, folderId: prev.folderId, folderName: prev.folderName })
          .onConflictDoNothing();
        await tx
          .insert(auditLog)
          .values({
            projectId: p.projectId,
            actorId: job.requestedBy,
            action: 'drive.folder_changed',
            payload: { canvasId: job.canvasId, from: prev.folderName, to: job.folderName },
          });
      });
      await this.d.events.broadcast(job.canvasId, { type: 'drive', event: 'folder_changed', by: await this.userName(job.requestedBy), link: f.webViewLink });
    } catch (e) {
      if (e instanceof DriveError && e.retryable && ctx.retryCount < ctx.retryLimit) throw e;
      await this.record(job.canvasId, 'failed', { requestedBy: job.requestedBy, error: `Troca de pasta: ${errText(e)}`, folderId: job.folderId, folderName: job.folderName });
      return;
    }
    // 3. exclusão definitiva do antigo (com retentativa pelo drive.cleanup)
    await this.cleanup(prev.fileId!);
  }

  /** Exclui de vez um arquivo antigo; em falha, agenda a próxima tentativa (até 24 h) */
  async cleanup(fileId: string) {
    const [row] = await this.d.db.select().from(drivePendingDeletions).where(eq(drivePendingDeletions.fileId, fileId));
    if (!row || row.gaveUpAt) return;
    try {
      if (!row.tokenUserId) throw new DriveError('invalid_grant', 'sem conta para excluir o arquivo antigo');
      const token = await this.d.tokens.get(row.tokenUserId);
      try {
        await this.d.provider.deleteFile(token, fileId);
      } catch (e) {
        if (!(e instanceof DriveError) || e.code !== 'restricted') throw e;
        await this.d.provider.setLock(token, fileId, false);
        await this.d.provider.deleteFile(token, fileId);
      }
      // nada do app sobra na pasta antiga (nem na lixeira)
      if (row.folderId) {
        const current = (await this.binding(row.canvasId))?.fileId;
        for (const f of await this.d.provider.findAppFiles(token, row.folderId, row.canvasId)) if (f.id !== current) await this.d.provider.deleteFile(token, f.id);
      }
      await this.d.db.delete(drivePendingDeletions).where(eq(drivePendingDeletions.fileId, fileId));
      await this.d.db
        .update(drivePublications)
        .set({ oldFileDeletedAt: new Date() })
        .where(and(eq(drivePublications.previousFileId, fileId), isNull(drivePublications.oldFileDeletedAt)));
    } catch (e) {
      const attempts = row.attempts + 1;
      const now = Date.now();
      const giveUp = now - row.createdAt.getTime() > CLEANUP_WINDOW_MS;
      await this.d.db
        .update(drivePendingDeletions)
        .set({ attempts, lastError: errText(e), nextAttemptAt: new Date(now + Math.min(2 ** attempts, 240) * 60_000), gaveUpAt: giveUp ? new Date(now) : null })
        .where(eq(drivePendingDeletions.fileId, fileId));
      this.d.log.warn({ err: e, fileId, attempts }, 'exclusão do arquivo antigo no Drive falhou');
    }
  }

  async disconnect(job: Extract<DriveJob, { type: 'disconnect' }>) {
    const b = await this.binding(job.canvasId);
    if (!b) return;
    if (job.deleteFile && b.fileId) {
      await this.d.db
        .insert(drivePendingDeletions)
        .values({ fileId: b.fileId, canvasId: job.canvasId, tokenUserId: b.connectedUserId, folderId: b.folderId, folderName: b.folderName })
        .onConflictDoNothing();
    }
    // sem o arquivo: uma reconexão cria outro (o "congelado", se ficou, não é mais do app)
    await this.update(job.canvasId, {
      status: 'paused',
      fileId: null,
      fileName: null,
      webViewLink: null,
      lastMd5: null,
      lastRevisionId: null,
      lastContentHash: null,
      anomaly: null,
      lock: 'none',
    });
    await this.record(job.canvasId, 'disconnected', {
      requestedBy: job.requestedBy,
      previousFileId: b.fileId,
      folderId: b.folderId,
      folderName: b.folderName,
      error: job.deleteFile ? null : 'arquivo mantido no Drive',
    });
    if (job.deleteFile && b.fileId) await this.cleanup(b.fileId);
  }

  /** Transferência de posse (§6): as publicações seguem no Drive do dono antigo até o novo escolher a pasta */
  async ownerTransferred(projectId: string, from: string, to: string, by: string) {
    const rows = await this.d.db
      .select()
      .from(driveBindings)
      .where(and(eq(driveBindings.projectId, projectId), ne(driveBindings.status, 'paused')));
    for (const b of rows) {
      const status = b.connectedUserId === to ? 'active' : 'transfer_pending';
      await this.update(b.canvasId, { status });
      await this.record(b.canvasId, 'owner_transferred', {
        requestedBy: by,
        folderId: b.folderId,
        folderName: b.folderName,
        error: status === 'transfer_pending' ? `aguardando o novo dono escolher uma pasta` : null,
      });
    }
    return rows.filter((b) => b.connectedUserId === from).length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Tarefas periódicas                                                   */
  /* ------------------------------------------------------------------ */

  async enqueueAudits() {
    const rows = await this.d.db.select({ canvasId: driveBindings.canvasId }).from(driveBindings).where(ne(driveBindings.status, 'paused'));
    for (const r of rows) await this.jobs.send({ type: 'audit', canvasId: r.canvasId }, r.canvasId);
  }

  async enqueueCleanups() {
    const rows = await this.d.db
      .select({ fileId: drivePendingDeletions.fileId, canvasId: drivePendingDeletions.canvasId })
      .from(drivePendingDeletions)
      .where(and(isNull(drivePendingDeletions.gaveUpAt), lte(drivePendingDeletions.nextAttemptAt, new Date())));
    for (const r of rows) await this.jobs.send({ type: 'cleanup', canvasId: r.canvasId, fileId: r.fileId }, r.canvasId);
  }

  async pendingDeletionsCount() {
    const rows = await this.d.db.select({ f: drivePendingDeletions.fileId }).from(drivePendingDeletions);
    return rows.length;
  }
}
