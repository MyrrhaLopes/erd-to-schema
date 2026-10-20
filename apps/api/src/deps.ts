import { createDb } from '@erd/db';
import { CanvasStore, createCollab } from '@erd/collab';
import { createAuth } from './auth';
import { roleOf, type CanvasWriter, type Deps } from './context';
import { createPgEvents } from './events';
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
  const store = overrides.store ?? new CanvasStore(db);
  const pgEvents = createPgEvents(pool, log);
  const collab =
    overrides.collab ??
    (overrides.realtime === false
      ? undefined
      : createCollab({ store, jwtSecret: env.COLLAB_JWT_SECRET, log: log.child({ component: 'collab' }), currentRole: (p, u) => roleOf(db, p, u) }));
  return {
    db,
    pool,
    env,
    auth,
    mailer,
    log,
    store,
    writer: overrides.writer ?? collab?.writer ?? storeWriter(store),
    events: overrides.events ?? pgEvents,
    collab,
  };
}

/** Ouve os eventos de permissão e repassa ao servidor de colaboração deste processo */
export async function wirePermissionEvents(deps: Deps) {
  if (!deps.collab) return async () => {};
  return createPgEvents(deps.pool, deps.log).subscribe((e) => deps.collab!.permissionChanged(e));
}
