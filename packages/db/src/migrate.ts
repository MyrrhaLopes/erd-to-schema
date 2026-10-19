// Migrador programático: roda no preDeployCommand do Railway, sem drizzle-kit na imagem.
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Pasta das migrações: ao lado do bundle (dist/migrations) ou no pacote (packages/db/migrations) */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'migrations'), join(here, '../migrations')]) if (existsSync(join(c, 'meta/_journal.json'))) return c;
  throw new Error('pasta de migrações não encontrada');
}

/** `when` da última migração do journal: o que o /readyz espera ver aplicado */
export function expectedMigration(): number {
  const journal = JSON.parse(readFileSync(join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: { when: number }[] };
  return journal.entries.at(-1)?.when ?? 0;
}

export async function runMigrations(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definida');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('migrações aplicadas'))
    .catch((e) => {
      console.error('falha na migração:', e);
      process.exit(1);
    });
}
