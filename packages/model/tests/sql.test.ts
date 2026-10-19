import { describe, expect, it } from 'vitest';
import { generateSql } from '../src/formats/sql/generate';
import { generatePrisma } from '../src/formats/prisma/generate';
import { generateDrizzle } from '../src/formats/drizzle/generate';
import { reconcile } from '../src/reconcile';
import { columnSql } from '../src/formats/sql/generate';
import { emptyProject, sql } from './helpers';

const DUMP = `
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE users (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  price numeric(10,2)[] DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  m mood,
  CHECK (id > 0)
);
CREATE TABLE posts (
  id bigint GENERATED ALWAYS AS IDENTITY,
  user_id int REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE tags (id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE post_tags (
  post_id bigint NOT NULL REFERENCES posts(id),
  tag_id int NOT NULL REFERENCES tags,
  PRIMARY KEY (post_id, tag_id)
);
CREATE UNIQUE INDEX posts_title_idx ON posts (title) WHERE title <> '';
COMMENT ON TABLE users IS 'Usuários';
COMMENT ON COLUMN users.email IS 'login';
-- @erd:ref posts(title) -> tags(name) N:N "título casa com tag"
-- @erd:tags users core, auth
`;

describe('SQL', () => {
  it('parses a dump', async () => {
    const p = await sql(DUMP);
    expect(p.schema.tables.map((t) => t.name)).toEqual(['users', 'posts', 'tags', 'post_tags']);
    const users = p.schema.tables[0];
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'email', 'price', 'created_at', 'm']);
    expect(users.columns[1]).toMatchObject({ type: { base: 'varchar', args: [255] }, nullable: false, unique: true, comment: 'login' });
    expect(users.columns[2].type).toEqual({ base: 'numeric', args: [10, 2], array: true });
    expect(users.columns[3].type).toEqual({ base: 'timestamptz' });
    expect(users.columns[3].default).toBe('now()');
    expect(users.checks[0].expr).toBe('id > 0');
    expect(users.comment).toBe('Usuários');
    const posts = p.schema.tables[1];
    expect(posts.columns[0].identity).toBe('always');
    expect(posts.indexes[0]).toMatchObject({ unique: true, where: "title <> ''" });
    const fks = p.schema.relationships.filter((r) => r.kind === 'fk');
    expect(fks).toHaveLength(3);
    expect(fks[0].onDelete).toBe('cascade');
    const notes = p.schema.relationships.filter((r) => r.kind === 'note');
    expect(notes[0]).toMatchObject({ cardinality: 'N:N', label: 'título casa com tag' });
    expect(p.meta[users.id].tags).toEqual(['core', 'auth']);
  });

  it('round-trips generate → parse', async () => {
    const p1 = await sql(DUMP);
    const text1 = generateSql(p1);
    const p2 = await sql(text1);
    const r = reconcile(p1, p2, 'sql', columnSql);
    expect(generateSql(r)).toBe(text1);
    expect(r.changes).toEqual([]);
  });

  it('reports syntax errors with position', async () => {
    const { parseSql } = await import('../src/formats/sql/parse');
    const { parse } = await import('libpg-query');
    const r = await parseSql('CREATE TABLE x (a int,,);', parse as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0].from).toBe(21);
  });

  it('keeps a column comment added without changing the column definition', async () => {
    const p1 = await sql('CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);');
    const base = reconcile(emptyProject(), p1, 'sql', columnSql);
    // só adiciona o COMMENT ON COLUMN; a definição da coluna não muda
    const p2 = await sql('CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL); COMMENT ON COLUMN users.email IS \'login\';');
    const r = reconcile(base, p2, 'sql', columnSql);
    expect(r.schema.tables[0].columns[1].comment).toBe('login');
    // e também quando o COMMENT ON TABLE muda sozinho
    const p3 = await sql('CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL); COMMENT ON TABLE users IS \'pessoas\'; COMMENT ON COLUMN users.email IS \'login\';');
    const r2 = reconcile(r, p3, 'sql', columnSql);
    expect(r2.schema.tables[0].comment).toBe('pessoas');
    expect(r2.schema.tables[0].columns[1].comment).toBe('login');
    // e que um COMMENT removido também some (não fica "preso")
    const p4 = await sql('CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);');
    const r3 = reconcile(r2, p4, 'sql', columnSql);
    expect(r3.schema.tables[0].columns[1].comment).toBeUndefined();
  });

  it('keeps ids across renames', async () => {
    const p1 = await sql('CREATE TABLE users (id serial PRIMARY KEY, name text, email text);');
    const base = reconcile(emptyProject(), p1, 'sql', columnSql);
    const p2 = await sql('CREATE TABLE people (id serial PRIMARY KEY, full_name text, email text);');
    const r = reconcile(base, p2, 'sql', columnSql);
    expect(r.schema.tables[0].id).toBe(base.schema.tables[0].id);
    expect(r.schema.tables[0].columns[1].id).toBe(base.schema.tables[0].columns[1].id);
    expect(r.changes).toContain('Tabela renomeada: users → people');
    expect(r.changes).toContain('Coluna renomeada: people.name → full_name');
  });

  it('maps entity comments (above and below table) and column comments (inline and preceding lines)', async () => {
    const rawSql = `
-- Tabela de usuários do sistema
-- Contém credenciais de acesso
CREATE TABLE users (
  -- Identificador único do usuário
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE, -- Login de e-mail
  /* Nome completo */
  name text -- Nome de exibição
);
-- Tabela sincronizada com serviço de autenticação
    `;
    const p = await sql(rawSql);
    const users = p.schema.tables[0];
    expect(users.comment).toBe(
      'Tabela de usuários do sistema\nContém credenciais de acesso\nTabela sincronizada com serviço de autenticação',
    );
    expect(users.columns[0].comment).toBe('Identificador único do usuário');
    expect(users.columns[1].comment).toBe('Login de e-mail');
    expect(users.columns[2].comment).toBe('Nome completo\nNome de exibição');

    // Propaga perfeitamente para Prisma
    const prismaOutput = generatePrisma(p);
    expect(prismaOutput).toContain('/// Tabela de usuários do sistema');
    expect(prismaOutput).toContain('/// Contém credenciais de acesso');
    expect(prismaOutput).toContain('/// Identificador único do usuário');
    expect(prismaOutput).toContain('/// Login de e-mail');

    // Propaga perfeitamente para Drizzle
    const drizzleOutput = generateDrizzle(p);
    expect(drizzleOutput).toContain('// Tabela de usuários do sistema');
    expect(drizzleOutput).toContain('// Identificador único do usuário');
    expect(drizzleOutput).toContain('// Login de e-mail');
  });

  it('serializes and parses note relationships with reverse toggle and reverse label', async () => {
    const s = await sql(`
      CREATE TABLE orders (id serial PRIMARY KEY, customer_id int);
      CREATE TABLE customers (id serial PRIMARY KEY, name text);
      -- @erd:ref orders(customer_id) -> customers(id) N:1 "pertence ao cliente" reverse 1:N "possui pedidos"
    `);
    expect(s.schema.relationships).toHaveLength(1);
    const rel = s.schema.relationships[0];
    expect(rel.kind).toBe('note');
    expect(rel.label).toBe('pertence ao cliente');
    expect(rel.showReverse).toBe(true);
    expect(rel.reverseCardinality).toBe('1:N');
    expect(rel.reverseLabel).toBe('possui pedidos');
    expect(rel.cardinality).toBe('N:1');

    const outSql = generateSql(s);
    expect(outSql).toContain(
      '-- @erd:ref orders(customer_id) -> customers(id) N:1 "pertence ao cliente" reverse 1:N "possui pedidos"',
    );

    // Reconciliação preserva os campos reversos
    const r = reconcile(emptyProject(), s, 'sql', columnSql);
    expect(r.schema.relationships[0].showReverse).toBe(true);
    expect(r.schema.relationships[0].reverseCardinality).toBe('1:N');
    expect(r.schema.relationships[0].reverseLabel).toBe('possui pedidos');
  });
});
