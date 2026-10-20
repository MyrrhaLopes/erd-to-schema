import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parse as pgParse } from 'libpg-query';
import type { Column, Project, Relationship, SchemaModel, Table } from '../src/types';
import { columnSql, generateSql } from '../src/formats/sql/generate';
import { parseSql } from '../src/formats/sql/parse';
import { generatePrisma, prismaColumnSignature } from '../src/formats/prisma/generate';
import { parsePrisma } from '../src/formats/prisma/parse';
import { drizzleColumnSignature, generateDrizzle } from '../src/formats/drizzle/generate';
import { parseDrizzle } from '../src/formats/drizzle/parse';
import { reconcile } from '../src/reconcile';
import type { Format } from '../src/types';
import type { ParseOutcome } from '../src/formats/common';

const TABLES = ['users', 'posts', 'orders', 'items', 'teams', 'projects'];
const COLS = ['name', 'title', 'score', 'is_active', 'created_at', 'note', 'qty', 'price', 'slug', 'body', 'mood'];

const typeFor: Record<string, fc.Arbitrary<Pick<Column, 'type' | 'default'>>> = {
  name: fc.constantFrom({ type: { base: 'text' } }, { type: { base: 'varchar', args: [120] }, default: "'x'" }),
  title: fc.constantFrom({ type: { base: 'text' }, default: "'untitled'" }, { type: { base: 'text' } }),
  score: fc.constantFrom({ type: { base: 'integer' }, default: '0' }, { type: { base: 'numeric', args: [10, 2] } }),
  is_active: fc.constantFrom({ type: { base: 'boolean' }, default: 'true' }, { type: { base: 'boolean' } }),
  created_at: fc.constantFrom({ type: { base: 'timestamptz' }, default: 'now()' }, { type: { base: 'timestamp', args: [3] } }),
  note: fc.constantFrom({ type: { base: 'text', array: true } }, { type: { base: 'jsonb' } }),
  qty: fc.constantFrom({ type: { base: 'bigint' } }, { type: { base: 'smallint' }, default: '1' }),
  price: fc.constantFrom({ type: { base: 'numeric', args: [12, 2] } }, { type: { base: 'double precision' } }),
  slug: fc.constantFrom({ type: { base: 'uuid' }, default: 'gen_random_uuid()' }, { type: { base: 'varchar', args: [64] } }),
  body: fc.constantFrom({ type: { base: 'text' } }, { type: { base: 'citext' } }),
  mood: fc.constantFrom({ type: { base: 'mood' }, default: "'ok'" }, { type: { base: 'mood' } }),
};

let seq = 0;
const id = (p: string) => `${p}${++seq}`;

const tableArb = (name: string) =>
  fc
    .record({
      pk: fc.constantFrom('serial', 'integer', 'bigserial'),
      cols: fc.uniqueArray(fc.constantFrom(...COLS), { minLength: 0, maxLength: 5 }),
      flags: fc.array(fc.record({ nullable: fc.boolean(), unique: fc.boolean() }), { minLength: 5, maxLength: 5 }),
      comment: fc.option(fc.constantFrom('tabela', "it's ok"), { nil: undefined }),
      check: fc.boolean(),
    })
    .chain((r) =>
      fc.tuple(...r.cols.map((c) => typeFor[c])).map((types) => {
        const pk: Column = { id: id('c'), name: 'id', type: { base: r.pk }, nullable: false };
        const columns: Column[] = [
          pk,
          ...r.cols.map((c, i) => ({
            id: id('c'),
            name: c,
            ...types[i],
            nullable: r.flags[i].nullable,
            ...(r.flags[i].unique && !types[i].type.array && types[i].type.base !== 'jsonb' ? { unique: true } : {}),
          })),
        ];
        const t: Table = {
          id: id('t'),
          name,
          columns,
          primaryKey: [pk.id],
          uniques: [],
          indexes: [],
          checks: r.check ? [{ id: id('k'), expr: 'id > 0' }] : [],
          comment: r.comment,
        };
        return t;
      }),
    );

const schemaArb: fc.Arbitrary<SchemaModel> = fc
  .uniqueArray(fc.constantFrom(...TABLES), { minLength: 1, maxLength: 4 })
  .chain((names) => fc.tuple(...names.map(tableArb)))
  .chain((sourceTables) =>
    fc
      .array(
        fc.record({
          from: fc.nat(sourceTables.length - 1),
          to: fc.nat(sourceTables.length - 1),
          nullable: fc.boolean(),
          onDelete: fc.constantFrom('no action', 'cascade', 'set null', 'restrict'),
        }),
        { maxLength: 4 },
      )
      .map((fks) => {
        // fast-check reaproveita valores ao encolher: nunca mutar o que veio do gerador
        const tables = structuredClone(sourceTables);
        const relationships: Relationship[] = [];
        for (const f of fks) {
          const from = tables[f.from];
          const to = tables[f.to];
          const colName = `${to.name.replace(/s$/, '')}_ref${relationships.length}`;
          const pkCol = to.columns[0];
          const t = pkCol.type.base === 'bigserial' ? 'bigint' : pkCol.type.base === 'serial' ? 'integer' : pkCol.type.base;
          const col: Column = { id: id('c'), name: colName, type: { base: t }, nullable: f.nullable };
          from.columns.push(col);
          relationships.push({
            id: id('r'),
            kind: 'fk',
            fromTable: from.id,
            fromColumns: [col.id],
            toTable: to.id,
            toColumns: [pkCol.id],
            onDelete: f.onDelete as Relationship['onDelete'],
            onUpdate: 'no action',
          });
        }
        return {
          tables,
          enums: tables.some((t) => t.columns.some((c) => c.type.base === 'mood'))
            ? [{ id: id('e'), name: 'mood', values: ['sad', 'ok'] }]
            : [],
          relationships,
        };
      }),
  );

const gen: Record<Format, (p: Pick<Project, 'schema' | 'meta'>) => string> = {
  sql: generateSql,
  prisma: generatePrisma,
  drizzle: generateDrizzle,
};
const sig = { sql: columnSql, prisma: prismaColumnSignature, drizzle: drizzleColumnSignature };
async function parse(f: Format, text: string): Promise<ParseOutcome> {
  if (f === 'sql') return parseSql(text, pgParse as never);
  if (f === 'prisma') return parsePrisma(text);
  return parseDrizzle(text);
}

async function step(model: Pick<Project, 'schema' | 'meta'>, f: Format) {
  const text = gen[f](model);
  const r = await parse(f, text);
  if (!r.ok) throw new Error(`${f} parse failed:\n${r.diagnostics.map((d) => d.message).join('\n')}\n---\n${text}`);
  return reconcile(model, r.parsed, f, sig[f]);
}

describe('round-trip property', () => {
  for (const f of ['sql', 'prisma', 'drizzle'] as Format[]) {
    it(`gen(${f}) → parse → reconcile preserves the model`, async () => {
      await fc.assert(
        fc.asyncProperty(schemaArb, async (schema) => {
          const model = { schema, meta: {} };
          const r = await step(model, f);
          expect(r.changes).toEqual([]);
          expect(generateSql(r)).toBe(generateSql(model));
        }),
        { numRuns: Number(process.env.FC_RUNS ?? 60) },
      );
    });
  }

  it('cross-format chain SQL → Prisma → Drizzle → SQL preserves the model', async () => {
    await fc.assert(
      fc.asyncProperty(schemaArb, async (schema) => {
        let m: Pick<Project, 'schema' | 'meta'> = { schema, meta: {} };
        const before = generateSql(m);
        for (const f of ['sql', 'prisma', 'drizzle', 'sql'] as Format[]) m = await step(m, f);
        expect(generateSql(m)).toBe(before);
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 60) },
    );
  });
});
