import type { Column, ColumnType, Project, Relationship, SchemaModel, Table } from '../../types';
import { camelCase, isValidJsIdent, modelNameFor, pascalCase, pluralize, uniqueName } from '../../naming';
import { columnById, relCardinality, relOptional, tableById } from '../../schema';

/** Tipo canônico → [scalar Prisma, atributo nativo @db] */
export function prismaScalar(t: ColumnType, enumName?: string): { scalar: string; native?: string } {
  if (enumName) return { scalar: enumName };
  const a = t.args ?? [];
  const args = a.length ? `(${a.join(', ')})` : '';
  switch (t.base) {
    case 'smallint':
    case 'smallserial':
      return { scalar: 'Int', native: '@db.SmallInt' };
    case 'integer':
    case 'serial':
      return { scalar: 'Int' };
    case 'bigint':
    case 'bigserial':
      return { scalar: 'BigInt' };
    case 'text':
      return { scalar: 'String' };
    case 'varchar':
      return { scalar: 'String', native: `@db.VarChar${args}` };
    case 'char':
      return { scalar: 'String', native: `@db.Char${args}` };
    case 'uuid':
      return { scalar: 'String', native: '@db.Uuid' };
    case 'citext':
      return { scalar: 'String', native: '@db.Citext' };
    case 'inet':
      return { scalar: 'String', native: '@db.Inet' };
    case 'xml':
      return { scalar: 'String', native: '@db.Xml' };
    case 'boolean':
      return { scalar: 'Boolean' };
    case 'timestamp':
      if (a.length === 1 && a[0] === 3) return { scalar: 'DateTime' };
      return { scalar: 'DateTime', native: `@db.Timestamp${args}` };
    case 'timestamptz':
      return { scalar: 'DateTime', native: `@db.Timestamptz${args}` };
    case 'date':
      return { scalar: 'DateTime', native: '@db.Date' };
    case 'time':
      return { scalar: 'DateTime', native: `@db.Time${args}` };
    case 'timetz':
      return { scalar: 'DateTime', native: `@db.Timetz${args}` };
    case 'numeric':
      return a.length ? { scalar: 'Decimal', native: `@db.Decimal${args}` } : { scalar: 'Decimal' };
    case 'money':
      return { scalar: 'Decimal', native: '@db.Money' };
    case 'real':
      return { scalar: 'Float', native: '@db.Real' };
    case 'double precision':
      return { scalar: 'Float' };
    case 'json':
      return { scalar: 'Json', native: '@db.Json' };
    case 'jsonb':
      return { scalar: 'Json' };
    case 'bytea':
      return { scalar: 'Bytes' };
    default: {
      const raw = t.base + args;
      return { scalar: `Unsupported(${JSON.stringify(raw)})` };
    }
  }
}

/** Inverso de prismaScalar */
export function canonicalFromPrisma(scalar: string, native: { name: string; args: number[] } | undefined, autoinc: boolean): ColumnType | null {
  const args = native?.args?.length ? native.args : undefined;
  const n = native?.name;
  switch (scalar) {
    case 'Int':
      if (n === 'SmallInt') return { base: autoinc ? 'smallserial' : 'smallint' };
      return { base: autoinc ? 'serial' : 'integer' };
    case 'BigInt':
      return { base: autoinc ? 'bigserial' : 'bigint' };
    case 'String':
      switch (n) {
        case 'VarChar':
          return { base: 'varchar', args };
        case 'Char':
          return { base: 'char', args };
        case 'Uuid':
          return { base: 'uuid' };
        case 'Citext':
          return { base: 'citext' };
        case 'Inet':
          return { base: 'inet' };
        case 'Xml':
          return { base: 'xml' };
        default:
          return { base: 'text' };
      }
    case 'Boolean':
      return { base: 'boolean' };
    case 'DateTime':
      switch (n) {
        case 'Timestamp':
          return { base: 'timestamp', args };
        case 'Timestamptz':
          return { base: 'timestamptz', args };
        case 'Date':
          return { base: 'date' };
        case 'Time':
          return { base: 'time', args };
        case 'Timetz':
          return { base: 'timetz', args };
        default:
          return { base: 'timestamp', args: [3] };
      }
    case 'Decimal':
      if (n === 'Money') return { base: 'money' };
      return { base: 'numeric', args };
    case 'Float':
      return { base: n === 'Real' ? 'real' : 'double precision' };
    case 'Json':
      return { base: n === 'Json' ? 'json' : 'jsonb' };
    case 'Bytes':
      return { base: 'bytea' };
  }
  return null;
}

export function cleanType(t: ColumnType): ColumnType {
  const out: ColumnType = { base: t.base };
  if (t.args?.length) out.args = t.args;
  if (t.array) out.array = true;
  return out;
}

export function enumValueIdent(v: string) {
  if (isValidJsIdent(v)) return v;
  const s = v.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([0-9])/, '_$1');
  return s || 'VALUE';
}

/* ------------------------------------------------------------------ */
/* Nomes Prisma derivados do modelo                                      */
/* ------------------------------------------------------------------ */

export interface PrismaNames {
  model: Map<string, string>; // tableId -> model name
  enumName: Map<string, string>; // enum db name -> prisma enum name
  field: Map<string, string>; // columnId -> field name
  relFrom: Map<string, string>; // relId -> field on from model
  relTo: Map<string, string>; // relId -> back-relation field on to model
  relName: Map<string, string | undefined>;
}

export function isImplicitPivot(project: Pick<Project, 'schema' | 'meta'>, t: Table): boolean {
  const p = project.meta[t.id]?.provenance;
  if (p?.kind !== 'pivot' || p.implicit !== 'prisma') return false;
  if (t.columns.length !== 2 || t.columns[0].name !== 'A' || t.columns[1].name !== 'B') return false;
  const fks = project.schema.relationships.filter((r) => r.kind === 'fk' && r.fromTable === t.id);
  return fks.length === 2;
}

export function computePrismaNames(project: Pick<Project, 'schema' | 'meta'>): PrismaNames {
  const { schema, meta } = project;
  const names: PrismaNames = {
    model: new Map(),
    enumName: new Map(),
    field: new Map(),
    relFrom: new Map(),
    relTo: new Map(),
    relName: new Map(),
  };
  const usedTypes = new Set<string>(['String', 'Int', 'BigInt', 'Boolean', 'DateTime', 'Decimal', 'Float', 'Json', 'Bytes']);
  for (const e of schema.enums) {
    const n = uniqueName(meta[e.id]?.formatNames?.prisma ?? pascalCase(e.name), usedTypes);
    usedTypes.add(n);
    names.enumName.set(e.name, n);
  }
  for (const t of schema.tables) {
    const n = uniqueName(meta[t.id]?.formatNames?.prisma ?? modelNameFor(t.name), usedTypes);
    usedTypes.add(n);
    names.model.set(t.id, n);
  }
  const fieldsTaken = new Map<string, Set<string>>();
  const taken = (tid: string) => {
    let s = fieldsTaken.get(tid);
    if (!s) fieldsTaken.set(tid, (s = new Set()));
    return s;
  };
  for (const t of schema.tables) {
    for (const c of t.columns) {
      const n = uniqueName(meta[c.id]?.formatNames?.prisma ?? camelCase(c.name), taken(t.id));
      taken(t.id).add(n);
      names.field.set(c.id, n);
    }
  }

  const fks = schema.relationships.filter((r) => r.kind === 'fk' && tableById(schema, r.fromTable) && tableById(schema, r.toTable));
  const pairCount = new Map<string, number>();
  const pairKey = (a: string, b: string) => [a, b].sort().join('|');
  for (const r of fks) pairCount.set(pairKey(r.fromTable, r.toTable), (pairCount.get(pairKey(r.fromTable, r.toTable)) ?? 0) + 1);

  // M:N implícito: pivots `_AToB` viram listas nos dois models
  const implicit = schema.tables.filter((t) => isImplicitPivot(project, t));
  const implicitIds = new Set(implicit.map((t) => t.id));

  for (const r of fks) {
    if (implicitIds.has(r.fromTable)) continue;
    const from = tableById(schema, r.fromTable)!;
    const fm = meta[r.id]?.formatNames;
    let base: string;
    if (fm?.prismaFrom) base = fm.prismaFrom;
    else if (r.fromColumns.length === 1) {
      const col = columnById(from, r.fromColumns[0])!;
      const stripped = col.name.replace(/(_id|Id|_fk|_ref)$/, '');
      base = stripped && stripped !== col.name ? camelCase(stripped) : camelCase(names.model.get(r.toTable)!);
    } else base = camelCase(names.model.get(r.toTable)!);
    const fromField = uniqueName(base, taken(r.fromTable));
    taken(r.fromTable).add(fromField);
    names.relFrom.set(r.id, fromField);

    const fromModel = names.model.get(r.fromTable)!;
    const card = relCardinality(schema, r);
    const needsName = r.fromTable === r.toTable || (pairCount.get(pairKey(r.fromTable, r.toTable)) ?? 0) > 1;
    const plain = card === '1:1' ? fromModel : pluralize(fromModel);
    // várias relações para o mesmo par: `editorPosts`, `authorPosts`…
    const backBase = fm?.prismaTo ?? camelCase(needsName ? `${fromField}_${plain}` : plain);
    const toField = uniqueName(backBase, taken(r.toTable));
    taken(r.toTable).add(toField);
    names.relTo.set(r.id, toField);

    names.relName.set(r.id, fm?.prismaRelation ?? (needsName ? `${fromModel}_${fromField}` : undefined));
  }

  for (const p of implicit) {
    const fm = meta[p.id]?.formatNames;
    const [ra, rb] = fks.filter((r) => r.fromTable === p.id).sort((x, y) => (columnById(p, x.fromColumns[0])!.name < columnById(p, y.fromColumns[0])!.name ? -1 : 1));
    const A = ra.toTable;
    const B = rb.toTable;
    const fa = uniqueName(fm?.prismaFrom ?? camelCase(pluralize(names.model.get(B)!)), taken(A));
    taken(A).add(fa);
    const fb = uniqueName(fm?.prismaTo ?? camelCase(pluralize(names.model.get(A)!)), taken(B));
    taken(B).add(fb);
    names.relFrom.set(p.id, fa);
    names.relTo.set(p.id, fb);
    const defaultName = `${names.model.get(A)}To${names.model.get(B)}`;
    const relName = p.name.startsWith('_') ? p.name.slice(1) : p.name;
    names.relName.set(p.id, relName !== defaultName ? relName : undefined);
  }
  return names;
}

export function relationOptional(schema: SchemaModel, r: Relationship) {
  return relOptional(schema, r);
}

export type { Column };
