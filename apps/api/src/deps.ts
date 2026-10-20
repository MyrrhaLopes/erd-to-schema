import { createDb } from '@erd/db';
import { randomUUID } from 'node:crypto';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Redis as IORedis } from 'ioredis';
import { CanvasStore, createCollab, RedisLeader } from '@erd/collab';
import { createAuth } from './auth';
import { roleOf, type CanvasWriter, type Deps } from './context';
import { createPgEvents } from './events';
import type { Env } from './env';
import { createLogger, type Logger } from './log';
import { createMailer, type Mailer } from './mailer';
import { BossMailQueue, InlineMailQueue } from './mailQueue';

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
}

export function createDeps(env: Env, overrides: DepsOptions = {}): Deps {
  const log = overrides.log ?? createLogger(env.LOG_LEVEL);
  const { db, pool } = overrides.db && overrides.pool ? { db: overrides.db, pool: overrides.pool } : createDb(env.DATABASE_URL);
  const mailer = overrides.mailer ?? createMailer(env, log);
  const auth = overrides.auth ?? createAuth({ db, env, mailer, log });
  const mail =
    overrides.mail ?? (env.NODE_ENV === 'test' ? new InlineMailQueue(mailer, log) : new BossMailQueue(env.DATABASE_URL, mailer, log.child({ component: 'mail' })));
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
  return {
    db,
    pool,
    env,
    auth,
    mailer,
    mail,
    log,
    store,
    writer: overrides.writer ?? collab?.writer ?? storeWriter(store),
    events,
    collab,
    redis,
  };
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
