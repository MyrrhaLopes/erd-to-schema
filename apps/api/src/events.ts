import type pg from 'pg';
import { PermissionChangedZ, type PermissionChanged } from '@erd/contracts';
import type { Events } from './context';
import type { Logger } from './log';

const CHANNEL = 'permission_changed';

/**
 * Eventos de permissão (§3) por Postgres `LISTEN/NOTIFY`: a API publica, o servidor de
 * colaboração (neste ou em outro processo) escuta. Com várias réplicas, o Redis pub/sub
 * substitui isto (fase 7).
 */
export function createPgEvents(pool: pg.Pool, log: Logger): Events & { subscribe(fn: (e: PermissionChanged) => void): Promise<() => Promise<void>> } {
  return {
    async permissionChanged(e) {
      await pool.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify(e)]);
    },
    async subscribe(fn) {
      let client: pg.PoolClient | null = null;
      let stopped = false;
      const connect = async () => {
        if (stopped) return;
        try {
          client = await pool.connect();
          client.on('notification', (m) => {
            if (m.channel !== CHANNEL || !m.payload) return;
            const r = PermissionChangedZ.safeParse(JSON.parse(m.payload));
            if (r.success) fn(r.data);
          });
          client.on('error', (err) => {
            log.warn({ err }, 'LISTEN caiu; reconectando');
            client?.release(true);
            client = null;
            setTimeout(() => void connect(), 1000);
          });
          await client.query(`LISTEN ${CHANNEL}`);
        } catch (err) {
          log.warn({ err }, 'falha no LISTEN; tentando de novo');
          setTimeout(() => void connect(), 2000);
        }
      };
      await connect();
      return async () => {
        stopped = true;
        if (client) {
          await client.query(`UNLISTEN ${CHANNEL}`).catch(() => {});
          client.release();
        }
      };
    },
  };
}
