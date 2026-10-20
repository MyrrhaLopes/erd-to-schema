import pg from 'pg';
import { createDb, type DbHandle } from './index';
import { runMigrations } from './migrate';

/**
 * Banco de teste descartável: um database novo (migrado) por arquivo de teste, no Postgres
 * do docker-compose ou no serviço do CI (`TEST_DATABASE_URL`).
 */
export async function createTestDatabase(): Promise<DbHandle & { url: string; drop: () => Promise<void> }> {
  const admin = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://erd:erd@localhost:5432/erd';
  const name = `erd_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const u = new URL(admin);
  u.pathname = '/' + name;
  const url = u.toString();
  await runMigrations(url);
  const h = createDb(url, { max: 5 });
  return {
    ...h,
    url,
    drop: async () => {
      await h.pool.end();
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
