import { createDb } from '@erd/db';
import { CanvasStore } from '@erd/collab';
import { createAuth } from './auth';
import type { CanvasWriter, Deps, Events } from './context';
import type { Env } from './env';
import { createLogger, type Logger } from './log';
import { createMailer, type Mailer } from './mailer';

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

export function createDeps(env: Env, overrides: Partial<Deps> & { log?: Logger; mailer?: Mailer } = {}): Deps {
  const log = overrides.log ?? createLogger(env.LOG_LEVEL);
  const { db, pool } = overrides.db && overrides.pool ? { db: overrides.db, pool: overrides.pool } : createDb(env.DATABASE_URL);
  const mailer = overrides.mailer ?? createMailer(env, log);
  const auth = overrides.auth ?? createAuth({ db, env, mailer, log });
  const store = overrides.store ?? new CanvasStore(db);
  const events: Events = overrides.events ?? {
    async permissionChanged(e) {
      log.info(e, 'permission-changed (sem servidor de colaboração)');
    },
  };
  return { db, pool, env, auth, mailer, log, store, writer: overrides.writer ?? storeWriter(store), events };
}
