import pg from 'pg';
import { runMigrations } from '@erd/db/migrate';

/**
 * Sem URL externa (`pnpm e2e` contra o dev), a API sobe com um banco próprio do e2e,
 * recriado e migrado a cada execução (roda antes de subir a API, no comando do webServer).
 */
async function prepare() {
  const admin = process.env.TEST_DATABASE_URL ?? 'postgres://erd:erd@localhost:5432/erd';
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query('DROP DATABASE IF EXISTS erd_e2e WITH (FORCE)');
  await c.query('CREATE DATABASE erd_e2e');
  await c.end();
  const u = new URL(admin);
  u.pathname = '/erd_e2e';
  await runMigrations(u.toString());
}

await prepare();
