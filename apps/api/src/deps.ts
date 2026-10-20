import { createDb } from '@erd/db';
import { randomUUID } from 'node:crypto';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Redis as IORedis } from 'ioredis';
import { CanvasStore, createCollab, RedisLeader } from '@erd/collab';
import { createAuth } from './auth';
import { roleOf, type CanvasWriter, type Deps } from './context';
import { createPgEvents } from './events';
import { driveProviderKind, type Env } from './env';
import { createLogger, type Logger } from './log';
import { createMailer, type Mailer } from './mailer';
import { BossMailQueue, InlineMailQueue } from './mailQueue';
import { BossJobQueue, InlineJobQueue, SharedBoss } from './queue';
import { DriveService, type DriveJob } from './drive/service';
import { DriveTokens } from './drive/token';
import { FakeDrive } from './drive/fake';
import { GoogleDrive } from './drive/google';
import type { DriveProvider } from './drive/provider';
import { emailIfAllowed, notify } from './notify';
import { eq, projects, users } from '@erd/db';

/** Escrita direto no log do banco (sem servidor de colaboração carregado) */
export function storeWriter(store: CanvasStore): CanvasWriter {
  return {
    async apply(canvasId, update) {
      await store.append(canvasId, update);
      if (await store.shouldCompact(canvasId)) await store.compact(canvasId);
    },
    read: (canvasId) => store.load(canvasId),
  };
}

export interface DepsOptions extends Partial<Deps> {
  log?: Logger;
  mailer?: Mailer;
  /** Liga o servidor de colaboração (Hocuspocus + sync bot) no mesmo processo */
  realtime?: boolean;
  /** Drive a usar no lugar do Google (testes) */
  driveProvider?: DriveProvider;
}

export function createDeps(env: Env, overrides: DepsOptions = {}): Deps {
  const log = overrides.log ?? createLogger(env.LOG_LEVEL);
  const { db, pool } = overrides.db && overrides.pool ? { db: overrides.db, pool: overrides.pool } : createDb(env.DATABASE_URL);
  const mailer = overrides.mailer ?? createMailer(env, log);
  const auth = overrides.auth ?? createAuth({ db, env, mailer, log });
  // uma instância pg-boss por processo: e-mails e jobs do Drive
  const boss = env.NODE_ENV === 'test' ? null : new SharedBoss(env.DATABASE_URL, log.child({ component: 'pg-boss' }));
  const mail = overrides.mail ?? (boss ? new BossMailQueue(boss, mailer, log.child({ component: 'mail' })) : new InlineMailQueue(mailer, log));
  const store = overrides.store ?? new CanvasStore(db);
  const events = overrides.events ?? createPgEvents(pool, log);
  // fase 7: com REDIS_URL, várias réplicas do `server` compartilham os documentos abertos
  // (extensão Redis do Hocuspocus) e elegem uma só para rodar o sync bot de cada documento
  const instanceId = `erd-${randomUUID().slice(0, 8)}`;
  const redis = env.REDIS_URL && overrides.realtime !== false ? new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false }) : undefined;
  const collab =
    overrides.collab ??
    (overrides.realtime === false
      ? undefined
      : createCollab({
          store,
          jwtSecret: env.COLLAB_JWT_SECRET,
          log: log.child({ component: 'collab', instance: instanceId }),
          currentRole: (p, u) => roleOf(db, p, u),
          ...(redis
            ? {
                extensions: [new RedisExtension({ redis, identifier: instanceId, prefix: 'erd' })],
                leader: new RedisLeader(redis, instanceId),
                multiInstance: true,
                forwardBotMessage: (documentName, msg) => void events.botMessage(documentName, msg),
              }
            : {}),
        }));
  const writer = overrides.writer ?? collab?.writer ?? storeWriter(store);
  const deps: Deps = { db, pool, env, auth, mailer, mail, log, store, writer, events, collab, redis };
  deps.drive = overrides.drive ?? createDrive(deps, boss, overrides.driveProvider);
  return deps;
}

/**
 * Documento Word no Drive (drive-docx-plan §9.1): o provider (Google, ou o falso em memória),
 * os tokens do dono e os jobs na mesma instância pg-boss dos e-mails, em série por canvas.
 * A auditoria roda a cada 6 h; a retentativa da exclusão definitiva, a cada 10 min.
 */
function createDrive(deps: Deps, boss: SharedBoss | null, provider?: DriveProvider): DriveService | undefined {
  const kind = provider?.kind ?? driveProviderKind(deps.env);
  if (!kind) return undefined;
  const log = deps.log.child({ component: 'drive' });
  const service = new DriveService({
    db: deps.db,
    provider: provider ?? (kind === 'fake' ? new FakeDrive() : new GoogleDrive()),
    tokens: new DriveTokens(deps.db, deps.auth, kind),
    events: deps.events,
    writer: deps.writer,
    log,
    alert: async (a) => {
      const [p] = await deps.db
        .select({ ownerId: projects.ownerId, name: projects.name, email: users.email })
        .from(projects)
        .innerJoin(users, eq(users.id, projects.ownerId))
        .where(eq(projects.id, a.projectId));
      if (!p) return;
      await notify(deps, [p.ownerId], 'drive-alert', { projectId: a.projectId, projectName: p.name, canvasId: a.canvasId, title: a.title, message: a.message });
      await emailIfAllowed(deps, p.ownerId, 'drive', {
        kind: 'driveAlert',
        to: p.email,
        props: { project: p.name, title: a.title, message: a.message, url: `${deps.env.APP_URL}/p/${a.projectId}/settings`, prefsUrl: `${deps.env.APP_URL}/settings` },
      });
    },
  });
  service.jobs = boss ? new BossJobQueue<DriveJob>(boss, 'drive', service.run, log) : new InlineJobQueue<DriveJob>(service.run, log);
  service.jobs.schedule('audit', '0 */6 * * *', () => service.enqueueAudits());
  service.jobs.schedule('cleanup', '*/10 * * * *', () => service.enqueueCleanups());
  return service;
}

/** Ouve os eventos (papel, avisos, pedidos ao bot) e repassa ao servidor de colaboração deste processo */
export async function wirePermissionEvents(deps: Deps) {
  const collab = deps.collab;
  if (!collab) return async () => {};
  return createPgEvents(deps.pool, deps.log).subscribe({
    permissionChanged: (e) => void collab.permissionChanged(e),
    broadcast: (canvasId, payload) => collab.broadcast(canvasId, payload),
    botMessage: (documentName, msg) => collab.handleBotMessage(documentName, msg),
  });
}
