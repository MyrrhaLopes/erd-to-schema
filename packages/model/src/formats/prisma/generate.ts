import type { Column, Project, RefAction, SchemaModel, Table } from '../../types';
import { columnById, relCardinality, relOptional, tableById } from '../../schema';
import { directiveLines } from '../common';
import { computePrismaNames, enumValueIdent, isImplicitPivot, prismaScalar, type PrismaNames } from './mapping';

const ACTION: Record<RefAction, string> = {
  'no action': 'NoAction',
  restrict: 'Restrict',
  cascade: 'Cascade',
  'set null': 'SetNull',
  'set default': 'SetDefault',
};

const isAutoinc = (c: Column) => ['serial', 'bigserial', 'smallserial'].includes(c.type.base) || !!c.identity;

function prismaDefault(c: Column, schema: SchemaModel): string | undefined {
  if (isAutoinc(c)) return 'autoincrement()';
  const d = c.default?.trim();
  if (!d) return undefined;
  if (/^(now\(\)|current_timestamp)$/i.test(d)) return 'now()';
  if (/^-?\d+(\.\d+)?$/.test(d)) return d;
  if (/^(true|false)$/i.test(d)) return d.toLowerCase();
  const lit = d.match(/^'((?:[^']|'')*)'(?:::[\w ."]+(?:\[\])?)?$/);
  if (lit) {
    const v = lit[1].replace(/''/g, "'");
    const en = schema.enums.find((e) => e.name === c.type.base);
    if (en && !c.type.array) return enumValueIdent(v);
    if (c.type.array && v === '{}') return '[]';
    if (!c.type.array && ['text', 'varchar', 'char', 'citext', 'uuid'].includes(c.type.base)) return JSON.stringify(v);
  }
  return `dbgenerated(${JSON.stringify(d)})`;
}

const docLines = (comment: string | undefined, indent: string) =>
  comment ? comment.split('\n').map((l) => `${indent}/// ${l}`) : [];

export function prismaFieldLine(c: Column, t: Table, schema: SchemaModel, names: PrismaNames): string {
  const en = schema.enums.find((e) => e.name === c.type.base);
  const { scalar, native } = prismaScalar(c.type, en ? names.enumName.get(en.name) : undefined);
  const fieldName = names.field.get(c.id) ?? c.name;
  let type = scalar;
  if (c.type.array) type += '[]';
  else if (c.nullable) type += '?';
  const attrs: string[] = [];
  if (t.primaryKey.length === 1 && t.primaryKey[0] === c.id) attrs.push('@id');
  const def = prismaDefault(c, schema);
  if (def) attrs.push(`@default(${def})`);
  if (c.unique && !(t.primaryKey.length === 1 && t.primaryKey[0] === c.id)) attrs.push('@unique');
  if (fieldName !== c.name) attrs.push(`@map(${JSON.stringify(c.name)})`);
  if (native) attrs.push(native);
  return [fieldName, type, ...attrs].join(' ');
}

export function generatePrisma(project: Pick<Project, 'schema' | 'meta'>): string {
  const { schema } = project;
  const names = computePrismaNames(project);
  const out: string[] = [];
  out.push(`datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}`);

  for (const e of schema.enums) {
    const n = names.enumName.get(e.name)!;
    const lines = e.values.map((v) => {
      const id = enumValueIdent(v);
      return `  ${id}${id !== v ? ` @map(${JSON.stringify(v)})` : ''}`;
    });
    if (n !== e.name) lines.push(`\n  @@map(${JSON.stringify(e.name)})`);
    out.push(`enum ${n} {\n${lines.join('\n')}\n}`);
  }

  const fks = schema.relationships.filter((r) => r.kind === 'fk' && tableById(schema, r.fromTable) && tableById(schema, r.toTable));
  const implicitPivots = schema.tables.filter((t) => isImplicitPivot(project, t));
  const implicitIds = new Set(implicitPivots.map((t) => t.id));

  for (const t of schema.tables) {
    if (implicitIds.has(t.id)) continue;
    const model = names.model.get(t.id)!;
    const rows: string[][] = [];
    const extra: string[] = [];
    const field = (cid: string) => names.field.get(cid) ?? columnById(t, cid)?.name ?? '?';

    for (const c of t.columns) {
      const docs = docLines(c.comment, '  ');
      const line = prismaFieldLine(c, t, schema, names);
      const parts = line.split(' ');
      rows.push([...docs.map((d) => '\0' + d), parts[0], parts[1], parts.slice(2).join(' ')]);
    }
    // relações em que esta tabela tem a FK
    for (const r of fks) {
      if (r.fromTable !== t.id || implicitIds.has(r.fromTable)) continue;
      const toModel = names.model.get(r.toTable)!;
      const to = tableById(schema, r.toTable)!;
      const args: string[] = [];
      const rn = names.relName.get(r.id);
      if (rn) args.push(JSON.stringify(rn));
      args.push(`fields: [${r.fromColumns.map(field).join(', ')}]`);
      args.push(`references: [${r.toColumns.map((c) => names.field.get(c) ?? columnById(to, c)?.name).join(', ')}]`);
      if (r.onDelete && r.onDelete !== 'no action') args.push(`onDelete: ${ACTION[r.onDelete]}`);
      if (r.onUpdate && r.onUpdate !== 'no action') args.push(`onUpdate: ${ACTION[r.onUpdate]}`);
      rows.push([
        ...docLines(r.comment, '  ').map((d) => '\0' + d),
        names.relFrom.get(r.id)!,
        toModel + (relOptional(schema, r) ? '?' : ''),
        `@relation(${args.join(', ')})`,
      ]);
    }
    // back-relations
    for (const r of fks) {
      if (r.toTable !== t.id || implicitIds.has(r.fromTable)) continue;
      const fromModel = names.model.get(r.fromTable)!;
      const card = relCardinality(schema, r);
      const rn = names.relName.get(r.id);
      rows.push([names.relTo.get(r.id)!, fromModel + (card === '1:1' ? '?' : '[]'), rn ? `@relation(${JSON.stringify(rn)})` : '']);
    }
    // M:N implícito
    for (const p of implicitPivots) {
      const [ra, rb] = fks
        .filter((r) => r.fromTable === p.id)
        .sort((x, y) => (columnById(p, x.fromColumns[0])!.name < columnById(p, y.fromColumns[0])!.name ? -1 : 1));
      const rn = names.relName.get(p.id);
      const attr = rn ? `@relation(${JSON.stringify(rn)})` : '';
      if (ra.toTable === t.id) rows.push([names.relFrom.get(p.id)!, names.model.get(rb.toTable)! + '[]', attr]);
      if (rb.toTable === t.id && !(ra.toTable === t.id && rb.toTable === t.id))
        rows.push([names.relTo.get(p.id)!, names.model.get(ra.toTable)! + '[]', attr]);
    }

    if (t.primaryKey.length > 1) extra.push(`@@id([${t.primaryKey.map(field).join(', ')}])`);
    for (const u of t.uniques) extra.push(`@@unique([${u.columns.map(field).join(', ')}])`);
    for (const i of t.indexes) {
      if (i.where) continue; // índice parcial não é expressável em Prisma (preservado no modelo)
      extra.push(`@@${i.unique ? 'unique' : 'index'}([${i.columns.map(field).join(', ')}])`);
    }
    if (model !== t.name) extra.push(`@@map(${JSON.stringify(t.name)})`);
    const hasIdentity = t.primaryKey.length > 0 || t.columns.some((c) => c.unique) || t.uniques.length > 0 || t.indexes.some((i) => i.unique && !i.where);
    if (!hasIdentity) extra.push('@@ignore // tabela sem PK/UNIQUE não pode ser model Prisma');
    for (const k of t.checks) extra.push(`// CHECK ${k.name ? k.name + ' ' : ''}(${k.expr.replace(/\n/g, ' ')}) — preservado, não expressável em Prisma`);
    for (const i of t.indexes)
      if (i.where) extra.push(`// índice parcial ${i.name ?? ''} WHERE ${i.where} — preservado, não expressável em Prisma`);

    // alinhamento em colunas, como o `prisma format`
    const plain = rows.map((r) => r.filter((x) => !x.startsWith('\0')));
    const w0 = Math.max(0, ...plain.map((r) => r[0].length));
    const w1 = Math.max(0, ...plain.map((r) => r[1].length));
    const body: string[] = [];
    for (const r of rows) {
      for (const d of r.filter((x) => x.startsWith('\0'))) body.push(d.slice(1));
      const [a, b, c] = r.filter((x) => !x.startsWith('\0'));
      body.push(`  ${a.padEnd(w0)} ${c ? b.padEnd(w1) + ' ' + c : b}`.trimEnd());
    }
    if (extra.length) body.push('', ...extra.map((e) => '  ' + e));
    out.push([...docLines(t.comment, ''), `model ${model} {`, ...body, '}'].join('\n'));
  }

  const directives = directiveLines(project as Project, 'prisma');
  if (directives.length) out.push('// Conceitos do canvas (relações-nota e tags)\n' + directives.join('\n'));
  return out.join('\n\n') + '\n';
}

const enumNameCache = new WeakMap<SchemaModel, PrismaNames>();

/** Assinatura de coluna para a reconciliação: o que o Prisma enxerga da coluna */
export function prismaColumnSignature(c: Column, t: Table, schema: SchemaModel): string {
  let names = enumNameCache.get(schema);
  if (!names) {
    names = { model: new Map(), enumName: new Map(), field: new Map(), relFrom: new Map(), relTo: new Map(), relName: new Map() };
    for (const e of schema.enums) names.enumName.set(e.name, e.name);
    enumNameCache.set(schema, names);
  }
  return c.name + ' ' + prismaFieldLine(c, t, schema, names) + (c.comment ? ' ///' + c.comment : '');
}
