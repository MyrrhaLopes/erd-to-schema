import { describe, expect, it } from 'vitest';
import { generateSql } from '../src/formats/sql/generate';
import { reconcile } from '../src/model/reconcile';
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
});
