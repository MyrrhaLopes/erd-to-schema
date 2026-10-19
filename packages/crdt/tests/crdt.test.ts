import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { produce } from 'immer';
import { parse as pgParse } from 'libpg-query';
import type { Column, Project } from '@erd/model/types';
import { parseSql } from '@erd/model/formats/sql/parse';
import { columnSql, generateSql } from '@erd/model/formats/sql/generate';
import { reconcile } from '@erd/model/reconcile';
import { emptyProject } from '@erd/model/project';
import { applyDiff, fromProject, LOCAL_ORIGIN, Projector, projectDoc, reorder, roots, type ProjectDoc } from '../src';
import { TableZ } from '../src/validate';

const SQL = `
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE users (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  name text,
  mood mood DEFAULT 'ok'
);
CREATE TABLE posts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  CONSTRAINT title_len CHECK (length(title) > 0)
);
CREATE INDEX posts_user_idx ON posts (user_id) WHERE body IS NOT NULL;
COMMENT ON TABLE users IS 'pessoas';
-- @erd:ref posts(title) -> users(name) N:1 "autor"
-- @erd:tags users core
`;

async function sampleDoc(): Promise<ProjectDoc> {
  const r = await parseSql(SQL, pgParse as never);
  if (!r.ok) throw new Error('parse');
  const p = emptyProject('Exemplo');
  const rec = reconcile(p, r.parsed, 'sql', columnSql);
  const doc: ProjectDoc = { name: 'Exemplo', schema: rec.schema, layout: {}, meta: rec.meta, notes: [{ id: 'n1', title: 'Nota', content: '# oi\n\n- a', color: 'blue' }] };
  rec.schema.tables.forEach((t, i) => (doc.layout[t.id] = { x: i * 300, y: 0 }));
  rec.schema.enums.forEach((e, i) => (doc.layout[e.id] = { x: i * 200, y: 500 }));
  doc.layout.n1 = { x: -300, y: 0, w: 260, h: 180 };
  return doc;
}

const strip = (p: ProjectDoc) => JSON.parse(JSON.stringify(p));

function docFrom(p: ProjectDoc): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, fromProject(p));
  return d;
}

describe('ida e volta', () => {
  it('project(fromProject(p)) ≡ p', async () => {
    const p = await sampleDoc();
    expect(strip(projectDoc(docFrom(p)))).toEqual(strip(p));
  });

  it('applyDiff(a, a) não gera nenhuma operação', async () => {
    const p = await sampleDoc();
    const d = docFrom(p);
    const before = Y.encodeStateVector(d);
    const cur = projectDoc(d);
    let wrote = false;
    d.transact(() => (wrote = applyDiff(d, cur, cur)));
    expect(wrote).toBe(false);
    expect(Y.encodeStateAsUpdate(d, before).length).toBeLessThanOrEqual(2);
    // mesmo com objetos estruturalmente iguais mas referências novas
    d.transact(() => (wrote = applyDiff(d, cur, strip(cur))));
    expect(wrote).toBe(false);
  });

  it('mover uma coluna reescreve uma chave de ordem só', async () => {
    const p = await sampleDoc();
    const d = docFrom(p);
    const cur = projectDoc(d);
    const next = produce(cur, (x) => {
      const t = x.schema.tables.find((t) => t.name === 'posts')!;
      const [c] = t.columns.splice(3, 1);
      t.columns.splice(0, 0, c);
    });
    const sv = Y.encodeStateVector(d);
    d.transact(() => applyDiff(d, cur, next));
    const proj = projectDoc(d);
    expect(proj.schema.tables.find((t) => t.name === 'posts')!.columns.map((c) => c.name)).toEqual(['body', 'id', 'user_id', 'title']);
    // a atualização é pequena (uma chave + carimbos), não a tabela inteira
    expect(Y.encodeStateAsUpdate(d, sv).length).toBeLessThan(120);
  });
});

describe('reorder', () => {
  it('mantém a maior subsequência e gera chaves entre os vizinhos', () => {
    const keys = new Map<string, string>();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const [id, k] of reorder(ids, () => undefined)) keys.set(id, k);
    const moved = reorder(['a', 'd', 'b', 'c', 'e'], (id) => keys.get(id));
    expect(moved.size).toBe(1);
    for (const [id, k] of moved) keys.set(id, k);
    const sorted = [...keys.entries()].sort((x, y) => (x[1] < y[1] ? -1 : 1)).map(([id]) => id);
    expect(sorted).toEqual(['a', 'd', 'b', 'c', 'e']);
  });
});

describe('projeção', () => {
  it('é incremental: entidades não tocadas mantêm a referência', async () => {
    const p = await sampleDoc();
    const d = docFrom(p);
    const proj = new Projector(d);
    d.on('afterTransaction', (tr) => proj.update(tr));
    const before = proj.current;
    const users = before.schema.tables.find((t) => t.name === 'users')!;
    const posts = before.schema.tables.find((t) => t.name === 'posts')!;
    d.transact(() => applyDiff(d, before, produce(before, (x) => void (x.schema.tables.find((t) => t.id === users.id)!.name = 'people'))), LOCAL_ORIGIN);
    const after = proj.current;
    expect(after.schema.tables.find((t) => t.id === users.id)!.name).toBe('people');
    expect(after.schema.tables.find((t) => t.id === posts.id)).toBe(posts);
    expect(after.notes).toBe(before.notes);
    expect(after.layout).toBe(before.layout);
    // mudança só de layout não recria o schema
    d.transact(() => applyDiff(d, after, produce(after, (x) => void (x.layout[posts.id].x = 999))), LOCAL_ORIGIN);
    expect(proj.current.schema).toBe(after.schema);
    expect(proj.current.layout[posts.id].x).toBe(999);
  });

  it('é tolerante: lixo no documento é ignorado e FK pendurada some', async () => {
    const p = await sampleDoc();
    const d = docFrom(p);
    const r = roots(d);
    d.transact(() => {
      const bad = new Y.Map<unknown>();
      r.tables.set('t_bad', bad);
      bad.set('name', 42);
      const usersId = p.schema.tables.find((t) => t.name === 'users')!.id;
      // apaga a tabela referenciada, como num merge concorrente
      r.tables.delete(usersId);
    });
    const proj = projectDoc(d);
    expect(proj.schema.tables.map((t) => t.name)).toEqual(['posts']);
    expect(proj.schema.relationships).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Convergência: réplicas concorrentes                                  */
/* ------------------------------------------------------------------ */

type Op =
  | { k: 'renameTable'; t: number; name: string }
  | { k: 'addColumn'; t: number; name: string }
  | { k: 'removeColumn'; t: number; c: number }
  | { k: 'moveColumn'; t: number; c: number; to: number }
  | { k: 'setType'; t: number; c: number; base: string }
  | { k: 'toggleNull'; t: number; c: number }
  | { k: 'addTable'; name: string }
  | { k: 'removeTable'; t: number }
  | { k: 'move'; t: number; x: number }
  | { k: 'note'; text: string }
  | { k: 'enumValue'; v: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant('renameTable' as const), t: fc.nat(5), name: fc.constantFrom('a', 'b', 'clientes', 'pedidos') }),
  fc.record({ k: fc.constant('addColumn' as const), t: fc.nat(5), name: fc.constantFrom('x', 'y', 'z', 'note') }),
  fc.record({ k: fc.constant('removeColumn' as const), t: fc.nat(5), c: fc.nat(6) }),
  fc.record({ k: fc.constant('moveColumn' as const), t: fc.nat(5), c: fc.nat(6), to: fc.nat(6) }),
  fc.record({ k: fc.constant('setType' as const), t: fc.nat(5), c: fc.nat(6), base: fc.constantFrom('text', 'integer', 'boolean', 'uuid') }),
  fc.record({ k: fc.constant('toggleNull' as const), t: fc.nat(5), c: fc.nat(6) }),
  fc.record({ k: fc.constant('addTable' as const), name: fc.constantFrom('tags', 'items', 'logs') }),
  fc.record({ k: fc.constant('removeTable' as const), t: fc.nat(5) }),
  fc.record({ k: fc.constant('move' as const), t: fc.nat(5), x: fc.integer({ min: -500, max: 500 }) }),
  fc.record({ k: fc.constant('note' as const), text: fc.string({ maxLength: 8 }) }),
  fc.record({ k: fc.constant('enumValue' as const), v: fc.constantFrom('meh', 'great', 'sad') }),
);

let seq = 0;
function applyOp(p: ProjectDoc, op: Op): ProjectDoc {
  return produce(p, (d) => {
    const ts = d.schema.tables;
    const t = ts.length ? ts[op.k === 'addTable' || op.k === 'note' || op.k === 'enumValue' ? 0 : op.t % ts.length] : undefined;
    switch (op.k) {
      case 'renameTable':
        if (t) t.name = op.name;
        break;
      case 'addColumn':
        if (t) t.columns.push({ id: `c_${++seq}_${Math.random().toString(36).slice(2, 6)}`, name: op.name, type: { base: 'text' }, nullable: true } as Column);
        break;
      case 'removeColumn':
        if (t && t.columns.length) {
          const c = t.columns[op.c % t.columns.length];
          t.columns.splice(op.c % t.columns.length, 1);
          t.primaryKey = t.primaryKey.filter((x) => x !== c.id);
          t.uniques = t.uniques.filter((u) => !u.columns.includes(c.id));
          t.indexes = t.indexes.filter((u) => !u.columns.includes(c.id));
          d.schema.relationships = d.schema.relationships.filter((r) => !r.fromColumns.includes(c.id) && !r.toColumns.includes(c.id));
        }
        break;
      case 'moveColumn':
        if (t && t.columns.length) {
          const [c] = t.columns.splice(op.c % t.columns.length, 1);
          t.columns.splice(op.to % (t.columns.length + 1), 0, c);
        }
        break;
      case 'setType':
        if (t && t.columns.length) t.columns[op.c % t.columns.length].type = { base: op.base };
        break;
      case 'toggleNull':
        if (t && t.columns.length) {
          const c = t.columns[op.c % t.columns.length];
          c.nullable = !c.nullable;
        }
        break;
      case 'addTable': {
        const id = `t_${++seq}_${Math.random().toString(36).slice(2, 6)}`;
        const cid = `c_${seq}_id`;
        ts.push({ id, name: op.name, columns: [{ id: cid, name: 'id', type: { base: 'serial' }, nullable: false }], primaryKey: [cid], uniques: [], indexes: [], checks: [] });
        d.layout[id] = { x: 0, y: 0 };
        break;
      }
      case 'removeTable':
        if (t) {
          d.schema.tables = ts.filter((x) => x.id !== t.id);
          d.schema.relationships = d.schema.relationships.filter((r) => r.fromTable !== t.id && r.toTable !== t.id);
          delete d.layout[t.id];
        }
        break;
      case 'move':
        if (t && d.layout[t.id]) d.layout[t.id].x = op.x;
        break;
      case 'note':
        if (d.notes[0]) d.notes[0].content = d.notes[0].content.slice(0, 3) + op.text + d.notes[0].content.slice(3);
        break;
      case 'enumValue':
        if (d.schema.enums[0]) d.schema.enums[0].values.push(op.v);
        break;
    }
  });
}

describe('convergência', () => {
  it('N réplicas com edições concorrentes terminam com a mesma projeção, válida e que gera SQL aceito pelo Postgres', async () => {
    const base = await sampleDoc();
    const initial = fromProject(base);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(opArb, { maxLength: 6 }), { minLength: 2, maxLength: 3 }), fc.nat(), async (opsPerReplica, shuffleSeed) => {
        const replicas = opsPerReplica.map(() => {
          const d = new Y.Doc();
          Y.applyUpdate(d, initial);
          return d;
        });
        const updates: Uint8Array[][] = replicas.map(() => []);
        replicas.forEach((d, i) => {
          d.on('update', (u: Uint8Array, origin: unknown) => origin === LOCAL_ORIGIN && updates[i].push(u));
          for (const op of opsPerReplica[i]) {
            const before = projectDoc(d);
            d.transact(() => applyDiff(d, before, applyOp(before, op), { by: `u${i}`, at: 1 }), LOCAL_ORIGIN);
          }
        });
        // cada réplica recebe os updates das outras numa ordem diferente
        replicas.forEach((d, i) => {
          const others = updates.flatMap((u, j) => (j === i ? [] : u));
          const order = others.map((_, k) => k).sort((a, b) => ((a * 7919 + shuffleSeed + i) % 13) - ((b * 7919 + shuffleSeed + i) % 13));
          for (const k of order) Y.applyUpdate(d, others[k]);
        });
        const projs = replicas.map((d) => strip(projectDoc(d)));
        for (const p of projs.slice(1)) expect(p).toEqual(projs[0]);
        for (const t of projs[0].schema.tables) expect(TableZ.safeParse(t).success).toBe(true);
        const sql = generateSql(projs[0] as Project);
        const r = await parseSql(sql, pgParse as never);
        expect(r.ok).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
