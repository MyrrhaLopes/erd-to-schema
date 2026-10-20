import { Hono } from 'hono';
import { lastAppliedMigration } from '@erd/db';
import { expectedMigration } from '@erd/db/migrate';
import type { Deps } from './context';

/**
 * `/healthz`: o processo está de pé. `/readyz`: o Postgres responde e a última migração
 * aplicada é a esperada — é o healthcheck do deploy: o Railway só troca o tráfego quando
 * ele responde 200.
 */
export function healthRoutes(deps: Pick<Deps, 'pool'>, state: { shuttingDown: boolean }) {
  let expected: number | null = null;
  return new Hono()
    .get('/healthz', (c) => c.text('ok'))
    .get('/readyz', async (c) => {
      if (state.shuttingDown) return c.text('desligando', 503);
      try {
        await deps.pool.query('select 1');
        expected ??= expectedMigration();
        const applied = await lastAppliedMigration(deps.pool);
        if (applied !== expected) return c.json({ ok: false, reason: 'migração pendente', applied, expected }, 503);
        return c.json({ ok: true });
      } catch (e) {
        return c.json({ ok: false, reason: (e as Error).message }, 503);
      }
    });
}
