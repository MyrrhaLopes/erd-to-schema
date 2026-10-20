import pg from 'pg';

/** Acesso direto ao banco do e2e (dev) — para montar cenários antes de existir a tela */
const url = (() => {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const u = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://erd:erd@localhost:5432/erd');
  u.pathname = process.env.URL ? '/erd_prod' : '/erd_e2e';
  return u.toString();
})();

export async function sql<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function addMember(projectId: string, email: string, role: 'editor' | 'viewer', color = 1) {
  const [u] = await sql<{ id: string }>('select id from users where email = $1', [email]);
  await sql('insert into project_members (project_id, user_id, role, color) values ($1, $2, $3, $4) on conflict (project_id, user_id) do update set role = $3', [projectId, u.id, role, color]);
}
