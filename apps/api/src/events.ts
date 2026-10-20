import type pg from 'pg';
import { z } from 'zod';
import { PermissionChangedZ, StatelessZ, type PermissionChanged } from '@erd/contracts';
import type { BotMessage } from '@erd/collab';
import type { Events } from './context';
import type { Logger } from './log';

const CHANNEL = 'permission_changed';
const COLLAB_CHANNEL = 'collab_event';

/** Avisos para todas as instâncias do servidor de colaboração (fase 7: várias réplicas) */
const CollabEventZ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('broadcast'), canvasId: z.string(), payload: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal('bot'), documentName: z.string(), msg: StatelessZ }),
]);
export type CollabEvent = z.infer<typeof CollabEventZ>;

export interface EventHandlers {
  permissionChanged(e: PermissionChanged): void;
  broadcast(canvasId: string, payload: Record<string, unknown>): void;
  botMessage(documentName: string, msg: BotMessage): void;
}

/**
 * Eventos entre a API e o servidor de colaboração por Postgres `LISTEN/NOTIFY` (§3): a API
 * publica, cada instância do collab (esta ou outras réplicas) escuta. Funciona igual com uma
 * ou várias réplicas, sem depender do Redis.
 */
export function createPgEvents(pool: pg.Pool, log: Logger): Events & { subscribe(h: EventHandlers): Promise<() => Promise<void>> } {
  const notify = (channel: string, payload: unknown) => pool.query('select pg_notify($1, $2)', [channel, JSON.stringify(payload)]).then(() => {});
  return {
    permissionChanged: (e) => notify(CHANNEL, e),
    broadcast: (canvasId, payload) => notify(COLLAB_CHANNEL, { kind: 'broadcast', canvasId, payload } satisfies CollabEvent),
    botMessage: (documentName, msg) => notify(COLLAB_CHANNEL, { kind: 'bot', documentName, msg } satisfies CollabEvent),
    async subscribe(h) {
      let client: pg.PoolClient | null = null;
      let stopped = false;
      const connect = async () => {
        if (stopped) return;
        try {
          client = await pool.connect();
          client.on('notification', (m) => {
            if (!m.payload) return;
            try {
              if (m.channel === CHANNEL) {
                const r = PermissionChangedZ.safeParse(JSON.parse(m.payload));
                if (r.success) h.permissionChanged(r.data);
              } else if (m.channel === COLLAB_CHANNEL) {
                const r = CollabEventZ.safeParse(JSON.parse(m.payload));
                if (!r.success) return;
                if (r.data.kind === 'broadcast') h.broadcast(r.data.canvasId, r.data.payload);
                else if (r.data.msg.type === 'flush' || r.data.msg.type === 'resolve' || r.data.msg.type === 'clear-divergent') h.botMessage(r.data.documentName, r.data.msg);
              }
            } catch (err) {
              log.warn({ err }, 'evento inválido');
            }
          });
          client.on('error', (err) => {
            log.warn({ err }, 'LISTEN caiu; reconectando');
            client?.release(true);
            client = null;
            setTimeout(() => void connect(), 1000);
          });
          await client.query(`LISTEN ${CHANNEL}`);
          await client.query(`LISTEN ${COLLAB_CHANNEL}`);
        } catch (err) {
          log.warn({ err }, 'falha no LISTEN; tentando de novo');
          setTimeout(() => void connect(), 2000);
        }
      };
      await connect();
      return async () => {
        stopped = true;
        if (client) {
          await client.query(`UNLISTEN *`).catch(() => {});
          client.release();
        }
      };
    },
  };
}
