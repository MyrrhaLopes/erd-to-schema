import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export * from './schema';
export { schema };
export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  // erro de conexão ociosa (ex.: Postgres reiniciou) não derruba o processo
  pool.on('error', (e) => console.error('[db] erro no pool', e.message));
  return { db: drizzle(pool, { schema }), pool };
}

/** Nome da última migração registrada pelo drizzle (o /readyz confere com a esperada) */
export async function lastAppliedMigration(pool: pg.Pool): Promise<number | null> {
  try {
    const r = await pool.query('select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1');
    return r.rows[0] ? Number(r.rows[0].created_at) : null;
  } catch {
    return null;
  }
}

// operadores do drizzle reexportados daqui: todo mundo usa a mesma instância do drizzle-orm
// (com peers diferentes, o pnpm pode instalar duas, e os tipos de uma não aceitam a outra)
export { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
