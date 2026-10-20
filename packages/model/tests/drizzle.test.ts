import { describe, expect, it } from 'vitest';
import { drizzleColumnSignature, generateDrizzle } from '../src/formats/drizzle/generate';
import { parseDrizzle } from '../src/formats/drizzle/parse';
import { columnSql, generateSql } from '../src/formats/sql/generate';
import { reconcile } from '../src/reconcile';
import { emptyProject, sql } from './helpers';

const drizzle = (text: string) => {
  const r = parseDrizzle(text);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('\n'));
  return r.parsed;
};

const DUMP = `
CREATE TYPE mood AS ENUM ('sad', 'ok');
CREATE TABLE users (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  score numeric(10,2) DEFAULT 0,
  status text DEFAULT 'active' NOT NULL,
  m mood DEFAULT 'ok',
  created_at timestamptz(3) DEFAULT now(),
  tags text[],
  data citext,
  CONSTRAINT positive CHECK (score >= 0)
);
CREATE TABLE posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id bigint REFERENCES posts(id),
  title text
);
CREATE TABLE post_likes (
  post_id bigint NOT NULL,
  user_id int NOT NULL,
  PRIMARY KEY (post_id, user_id),
  CONSTRAINT like_post FOREIGN KEY (post_id) REFERENCES posts (id)
);
CREATE INDEX posts_title_idx ON posts (title) WHERE title IS NOT NULL;
-- @erd:ref posts(title) -> users(email) "nota"
`;

describe('Drizzle', () => {
  it('SQL → Drizzle → SQL is lossless', async () => {
    const base = reconcile(emptyProject(), await sql(DUMP), 'sql', columnSql);
    const sql1 = generateSql(base);
    const ts = generateDrizzle(base);
    const p = drizzle(ts);
    const r = reconcile(base, p, 'drizzle', drizzleColumnSignature);
    expect(r.changes).toEqual([]);
    expect(generateSql(r)).toBe(sql1);
    expect(generateDrizzle(r)).toBe(ts);
  });

  it('supports helpers, loops and spread (code is executed, not parsed)', () => {
    const p = drizzle(`
      import { pgTable, serial, timestamp, text } from 'drizzle-orm/pg-core';
      const timestamps = { createdAt: timestamp('created_at').defaultNow().notNull(), updatedAt: timestamp('updated_at') };
      const make = (name: string) => pgTable(name, { id: serial('id').primaryKey(), label: text('label'), ...timestamps });
      export const a = make('a');
      export const b = make('b');
    `);
    expect(p.schema.tables.map((t) => t.name)).toEqual(['a', 'b']);
    expect(p.schema.tables[0].columns.map((c) => c.name)).toEqual(['id', 'label', 'created_at', 'updated_at']);
    expect(p.schema.tables[0].columns[2]).toMatchObject({ default: 'now()', nullable: false });
  });

  it('rejects foreign imports and reports the line of runtime errors', () => {
    const r = parseDrizzle(`import fs from 'fs';\nexport const x = fs;`);
    expect(r.ok).toBe(false);
    const r2 = parseDrizzle(`import { pgTable } from 'drizzle-orm/pg-core';\n\nexport const t = pgTable('t', { id: notDefined() });`);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.diagnostics[0].message).toMatch(/notDefined/);
  });

  it('reflects SQL comments into the generated Drizzle code (not read back, not expressible in drizzle)', async () => {
    const base = reconcile(emptyProject(), await sql(`CREATE TABLE a (id serial PRIMARY KEY); COMMENT ON TABLE a IS 'hello'; COMMENT ON COLUMN a.id IS 'pk';`), 'sql', columnSql);
    const ts = generateDrizzle(base);
    // os comentários do SQL aparecem como comentários de código no Drizzle…
    expect(ts).toContain('// hello');
    expect(ts).toContain('// pk');
    const ts2 = ts.replace("id: serial('id').primaryKey(),", "id: serial('id').primaryKey(),\n  name: text('name'),").replace('import { pgTable, serial }', 'import { pgTable, serial, text }');
    // …mas, como comentários JS somem ao executar o código, o modelo continua sendo a fonte da verdade
    const r = reconcile(base, drizzle(ts2), 'drizzle', drizzleColumnSignature);
    const out = generateSql(r);
    expect(out).toContain("COMMENT ON TABLE a IS 'hello'");
    expect(out).toContain("COMMENT ON COLUMN a.id IS 'pk'");
    expect(out).toContain('name text');
  });
});
