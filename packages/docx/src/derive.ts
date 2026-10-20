import type { Cardinality, Column, DocContent, EnumType, Id, Index, Project, Relationship, SchemaModel, Table } from '@erd/model/types';
import { formatType } from '@erd/model/columnType';
import { prismaScalar } from '@erd/model/formats/prisma/mapping';
import { columnById, isUniqueSet, tableById } from '@erd/model/schema';
import { pivotEnds } from '@erd/model/tags';

/** Regras de derivação das tabelas do documento (drive-docx-plan §1.3) */

export const DASH = '—';

const SERIALS = new Set(['serial', 'bigserial', 'smallserial']);

const enumOf = (schema: SchemaModel, c: Column): EnumType | undefined => (c.type.array ? undefined : schema.enums.find((e) => e.name === c.type.base));

/** Nome do tipo no estilo Prisma, como no documento de referência (`VarChar(255)`, `UUID`, `JsonB`) */
export function typeLabel(schema: SchemaModel, c: Column, style: DocContent['typeStyle']): string {
  if (style === 'sql') return formatType(c.type);
  const e = schema.enums.find((x) => x.name === c.type.base);
  if (e) return e.name + (c.type.array ? '[]' : '');
  const SPECIAL: Record<string, string> = { uuid: 'UUID', jsonb: 'JsonB', json: 'Json', text: 'Text', date: 'Date', citext: 'Citext', inet: 'Inet' };
  let name = SPECIAL[c.type.base];
  if (!name) {
    const { scalar, native } = prismaScalar({ ...c.type, array: false });
    if (native) name = native.replace(/^@db\./, '').replace(/,\s*/g, ',');
    else if (scalar.startsWith('Unsupported(')) name = formatType({ ...c.type, array: false });
    else name = scalar;
  }
  return name + (c.type.array ? '[]' : '');
}

/** Tira aspas e casts do SQL: `'ACTIVE'::status` → `ACTIVE`, `'{}'::jsonb` → `{}` */
export function cleanSql(expr: string): string {
  return expr
    .replace(/\bCAST\(\s*('(?:[^']|'')*'|[^()]*?)\s+AS\s+[^()]+?(\(\d+(,\s*\d+)?\))?\s*\)/gi, '$1')
    .replace(/::\s*"?[\w.]+"?(\s*\[\])?(\(\d+(,\s*\d+)?\))?/g, '')
    .replace(/'((?:[^']|'')*)'/g, (_m, s: string) => s.replace(/''/g, "'"))
    .trim();
}

export function defaultLabel(schema: SchemaModel, t: Table, c: Column): string {
  if (c.identity || SERIALS.has(c.type.base)) return 'autoincrement';
  const d = c.default?.trim();
  if (d) {
    const low = d.toLowerCase().replace(/\s+/g, '');
    if (/^(gen_random_uuid|uuid_generate_v4)\(\)$/.test(low)) return 'uuid()';
    if (/^(now\(\)|current_timestamp|current_timestamp\(\d*\)|localtimestamp|transaction_timestamp\(\))$/.test(low)) return 'now()';
    if (low === 'current_date') return 'today()';
    return cleanSql(d);
  }
  const isFk = schema.relationships.some((r) => r.kind === 'fk' && r.fromTable === t.id && r.fromColumns.includes(c.id));
  if (isFk && c.nullable) return 'NULL';
  return DASH;
}

const colNames = (t: Table, ids: Id[]) => ids.map((id) => columnById(t, id)?.name ?? '?');

export function indexLabel(t: Table, ix: Pick<Index, 'columns' | 'unique' | 'where'>): string {
  return `${ix.unique ? 'UNIQUE' : 'INDEX'}(${colNames(t, ix.columns).join(', ')})${ix.where ? ` WHERE ${cleanSql(ix.where)}` : ''}`;
}

export function uniqueLabel(t: Table, c: Column): string {
  if (t.primaryKey.length === 1 && t.primaryKey[0] === c.id) return 'PK';
  const single = (cols: Id[]) => cols.length === 1 && cols[0] === c.id;
  if (c.unique || t.uniques.some((u) => single(u.columns)) || t.indexes.some((i) => i.unique && !i.where && single(i.columns))) return 'Sim';
  if (
    (t.primaryKey.length > 1 && t.primaryKey.includes(c.id)) ||
    t.uniques.some((u) => u.columns.length > 1 && u.columns.includes(c.id)) ||
    t.indexes.some((i) => i.unique && !i.where && i.columns.length > 1 && i.columns.includes(c.id))
  )
    return 'Composto';
  if (t.indexes.some((i) => i.unique && i.where && i.columns.includes(c.id))) return 'Parcial';
  return 'Não';
}

const fksFrom = (schema: SchemaModel, t: Table, c: Column) => schema.relationships.filter((r) => r.kind === 'fk' && r.fromTable === t.id && r.fromColumns.includes(c.id));

export function fkLabel(schema: SchemaModel, t: Table, c: Column): string {
  const out = fksFrom(schema, t, c).map((r) => {
    const target = tableById(schema, r.toTable);
    const i = r.fromColumns.indexOf(c.id);
    return `${target?.name ?? '?'}.${columnById(target, r.toColumns[i])?.name ?? '?'}`;
  });
  return out.length ? out.join('; ') : DASH;
}

export function rulesLabel(schema: SchemaModel, t: Table, c: Column): string {
  const parts: string[] = [];
  if (t.primaryKey.includes(c.id)) parts.push('PK; índice implícito.');
  const e = enumOf(schema, c);
  if (e) parts.push(e.values.join(' | '));
  for (const u of t.uniques) if (u.columns.length > 1 && u.columns.includes(c.id)) parts.push(`UNIQUE(${colNames(t, u.columns).join(', ')})`);
  for (const ix of t.indexes) if (ix.columns.includes(c.id)) parts.push(indexLabel(t, ix));
  for (const r of fksFrom(schema, t, c)) if (r.onDelete) parts.push(`ON DELETE ${r.onDelete.toUpperCase()}`);
  if (c.unique && c.nullable) parts.push('UNIQUE quando informado');
  return parts.length ? parts.join('; ') : DASH;
}

export interface FieldRow {
  columnId: Id;
  cells: [string, string, string, string, string, string, string, string, string];
  isEnum: boolean;
}

export const FIELD_HEADER = ['Campo', 'Descrição / note', 'Tipo', 'NULL?', 'PK', 'FK', 'Unique', 'Default', 'Índices / regras'];

export function fieldRows(schema: SchemaModel, t: Table, style: DocContent['typeStyle']): FieldRow[] {
  return t.columns.map((c) => ({
    columnId: c.id,
    isEnum: !!schema.enums.find((e) => e.name === c.type.base),
    cells: [
      c.name,
      c.comment?.trim() || DASH,
      typeLabel(schema, c, style),
      c.nullable ? 'Sim' : 'Não',
      t.primaryKey.includes(c.id) ? 'Sim' : 'Não',
      fkLabel(schema, t, c),
      uniqueLabel(t, c),
      defaultLabel(schema, t, c),
      rulesLabel(schema, t, c),
    ],
  }));
}

/* ------------------------------------------------------------------ */
/* Relacionamentos                                                      */
/* ------------------------------------------------------------------ */

export const REL_HEADER = ['Relacionamento', 'Cardinalidade', 'FK / regra', 'ON DELETE', 'Função'];

/** Multiplicidades lidas da tabela da seção para a outra (esquerda : direita) */
type Mult = [string, string];
const fmt = (m: Mult) => `${m[0]} : ${m[1]}`;
const invert = (m: Mult): Mult => [m[1], m[0]];

const NOTE_CARD: Record<Cardinality, Mult> = {
  '1:1': ['1', '1'],
  'N:1': ['N', '1'],
  '1:N': ['1', 'N'],
  'N:N': ['N', 'N'],
  '0:1': ['N', '0..1'],
  '0:N': ['0..1', 'N'],
};

function fkMult(schema: SchemaModel, r: Relationship): Mult {
  const from = tableById(schema, r.fromTable);
  const nullable = !!from && r.fromColumns.some((c) => columnById(from, c)?.nullable);
  const unique = !!from && isUniqueSet(from, r.fromColumns);
  return [unique ? '1' : 'N', nullable ? '0..1' : '1'];
}

function ends(schema: SchemaModel, r: Relationship) {
  const from = tableById(schema, r.fromTable);
  const to = tableById(schema, r.toTable);
  const side = (t: Table | undefined, ids: Id[]) => {
    const names = colNames(t ?? ({ columns: [] } as unknown as Table), ids);
    return `${t?.name ?? '?'}.${names.length === 1 ? names[0] : `(${names.join(', ')})`}`;
  };
  return `${side(from, r.fromColumns)} → ${side(to, r.toColumns)}`;
}

export interface RelRow {
  /** ID da relação (ou `pivot:<id>` para o N:N via pivot) e de que lado a seção está */
  key: Id;
  side: 'from' | 'to';
  other: Id;
  cells: [string, string, string, string, string];
  /** Rótulo para desambiguar várias relações com a mesma tabela */
  label: string;
  /** Função veio do formulário (ou do rótulo da relação-nota)? */
  hasFunction: boolean;
}

function fkDefaultLabel(schema: SchemaModel, r: Relationship): string {
  if (r.label) return r.label;
  const from = tableById(schema, r.fromTable);
  return colNames(from ?? ({ columns: [] } as unknown as Table), r.fromColumns)
    .map((n) => n.replace(/(_id|Id|_fk)$/, ''))
    .join(', ');
}

/** Relações da tabela da seção: FKs de saída, de entrada, relações-nota e N:N via pivot */
export function relationshipRows(project: Pick<Project, 'schema' | 'meta'>, t: Table, content: DocContent): RelRow[] {
  const { schema } = project;
  interface Raw {
    key: Id;
    side: 'from' | 'to';
    other: Id;
    label: string;
    card: Mult;
    rule: string;
    onDelete: string;
    fn: string | undefined;
    logical: boolean;
  }
  const rows: Raw[] = [];
  const fnOf = (key: Id, side: 'from' | 'to', fallback?: string) => {
    const e = content.relationships[key];
    const v = (side === 'from' ? e?.fromSide : e?.toSide)?.trim();
    return v || fallback?.trim() || undefined;
  };
  for (const r of schema.relationships) {
    if (r.fromTable !== t.id && r.toTable !== t.id) continue;
    if (!tableById(schema, r.fromTable) || !tableById(schema, r.toTable)) continue;
    const side: 'from' | 'to' = r.fromTable === t.id ? 'from' : 'to';
    const other = side === 'from' ? r.toTable : r.fromTable;
    if (r.kind === 'fk') {
      const m = fkMult(schema, r);
      rows.push({
        key: r.id,
        side,
        other,
        label: fkDefaultLabel(schema, r),
        card: side === 'from' ? m : invert(m),
        rule: ends(schema, r),
        onDelete: (r.onDelete ?? 'no action').toUpperCase(),
        fn: fnOf(r.id, side),
        logical: false,
      });
    } else {
      const m = NOTE_CARD[r.cardinality ?? 'N:1'];
      rows.push({
        key: r.id,
        side,
        other,
        label: (side === 'from' ? r.label : r.reverseLabel || r.label) ?? '',
        card: side === 'from' ? m : invert(m),
        rule: ends(schema, r),
        onDelete: 'Aplicação',
        fn: fnOf(r.id, side, side === 'from' ? r.label : r.reverseLabel),
        logical: true,
      });
    }
  }
  // N:N: a tabela da seção é uma das pontas de um pivot
  for (const pivot of schema.tables) {
    if (pivot.id === t.id) continue;
    const e = pivotEnds(project as Project, pivot);
    if (!e || (e.a !== t.id && e.b !== t.id) || e.a === e.b) continue;
    const side: 'from' | 'to' = e.a === t.id ? 'from' : 'to';
    const other = side === 'from' ? e.b : e.a;
    if (!tableById(schema, other)) continue;
    const fk = schema.relationships.find((r) => r.kind === 'fk' && r.fromTable === pivot.id && r.toTable === t.id);
    rows.push({
      key: `pivot:${pivot.id}`,
      side,
      other,
      label: `via ${pivot.name}`,
      card: ['N', 'N'],
      rule: `via ${pivot.name}`,
      onDelete: (fk?.onDelete ?? 'no action').toUpperCase(),
      fn: fnOf(`pivot:${pivot.id}`, side),
      logical: false,
    });
  }
  const perOther = new Map<Id, number>();
  for (const r of rows) perOther.set(r.other, (perOther.get(r.other) ?? 0) + 1);
  return rows.map((r) => {
    const otherName = tableById(schema, r.other)?.name ?? '?';
    let name = `${t.name} → ${otherName}`;
    if ((perOther.get(r.other) ?? 0) > 1 && r.label && !r.label.startsWith('via ')) name += ` (${r.label})`;
    if (r.label.startsWith('via ')) name += ` (${r.label})`;
    if (r.logical) name += ' (lógico)';
    return {
      key: r.key,
      side: r.side,
      other: r.other,
      label: r.label,
      hasFunction: !!r.fn,
      cells: [name, fmt(r.card), r.rule, r.onDelete, r.fn ?? DASH],
    };
  });
}

/* ------------------------------------------------------------------ */
/* Convenções detectadas                                                */
/* ------------------------------------------------------------------ */

export interface Convention {
  key: string;
  name: string;
  pattern: string;
  goal: string;
  detected: boolean;
}

export const CONV_HEADER = ['Convenção', 'Padrão', 'Objetivo'];

const AUDIT = ['created_at', 'updated_at', 'created_by', 'updated_by'];
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Linhas detectadas no modelo (padrão de PK, uuid, auditoria, status) + as acrescentadas no formulário */
export function detectConventions(schema: SchemaModel, content: DocContent): Convention[] {
  const out: Omit<Convention, 'goal'>[] = [];
  const tables = schema.tables;
  if (tables.length) {
    // PK: o padrão é o par (nome, tipo) mais comum entre as PKs de uma coluna
    const sig = (t: Table) => {
      if (t.primaryKey.length !== 1) return null;
      const c = columnById(t, t.primaryKey[0]);
      if (!c) return null;
      return `${c.name}|${typeLabel(schema, c, content.typeStyle)}|${c.identity || SERIALS.has(c.type.base) ? 'auto' : c.default ? cleanSql(c.default) : ''}`;
    };
    const counts = new Map<string, number>();
    for (const t of tables) {
      const s = sig(t);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) {
      const [name, type, gen] = best[0].split('|');
      out.push({ key: 'pk', name: 'Chave primária', pattern: `${name} ${type}${gen === 'auto' ? ' (autoincrement)' : gen ? ` (default ${gen})` : ''}`, detected: true });
      for (const t of tables) {
        if (sig(t) === best[0]) continue;
        const cols = colNames(t, t.primaryKey);
        out.push({
          key: `exception:${t.id}`,
          name: `Exceção ${t.name}`,
          pattern: cols.length ? (cols.length > 1 ? `PK composta (${cols.join(', ')})` : `PK ${cols[0]}`) : 'Sem chave primária',
          detected: true,
        });
      }
    }
    const withUuid = tables.filter((t) => t.columns.some((c) => c.name.toLowerCase() === 'uuid' && c.type.base === 'uuid' && (c.unique || isUniqueSet(t, [c.id]))));
    if (withUuid.length) out.push({ key: 'uuid', name: 'Identificador público', pattern: `uuid UUID único (${withUuid.length} de ${tables.length} tabelas)`, detected: true });
    const audit = AUDIT.filter((a) => tables.filter((t) => t.columns.some((c) => snake(c.name) === a)).length * 2 >= tables.length);
    if (audit.length) out.push({ key: 'audit', name: 'Colunas de auditoria', pattern: audit.join(', '), detected: true });
    const statusEnums = new Map<string, number>();
    for (const t of tables)
      for (const c of t.columns) if (c.name.toLowerCase() === 'status' && enumOf(schema, c)) statusEnums.set(c.type.base, (statusEnums.get(c.type.base) ?? 0) + 1);
    const common = [...statusEnums.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
    if (common) {
      const e = schema.enums.find((x) => x.name === common[0])!;
      out.push({ key: 'status', name: 'Status comum', pattern: `status ${e.name} (${e.values.join(' | ')})`, detected: true });
    }
  }
  const goals = content.conventions.detected;
  return [
    ...out.map((c) => ({ ...c, goal: goals[c.key]?.goal?.trim() ?? '' })),
    ...content.conventions.extra.map((x, i) => ({ key: `extra:${i}`, name: x.name, pattern: x.pattern, goal: x.goal.trim(), detected: false })),
  ];
}

/* ------------------------------------------------------------------ */
/* Marcadores e apêndices                                               */
/* ------------------------------------------------------------------ */

/** Marcadores gerados de uma tabela: índices únicos parciais e CHECKs (as regras do formulário vêm depois) */
export function generatedBullets(t: Table): string[] {
  const out: string[] = [];
  for (const ix of t.indexes) if (ix.unique && ix.where) out.push(`Aplicar índice único parcial: ${indexLabel(t, ix)}`);
  for (const ch of t.checks) out.push(`Validar ${ch.name ? `${ch.name}: ` : ''}CHECK (${cleanSql(ch.expr)})`);
  return out;
}

export function uniqueSummary(t: Table): string[] {
  const out: string[] = [];
  for (const c of t.columns) if (c.unique) out.push(`UNIQUE(${c.name})`);
  for (const u of t.uniques) out.push(`UNIQUE(${colNames(t, u.columns).join(', ')})`);
  for (const ix of t.indexes) if (ix.unique) out.push(ix.where ? `${indexLabel(t, ix)} (via índice parcial)` : indexLabel(t, ix));
  return out;
}

export function indexSummary(t: Table): string[] {
  return t.indexes.filter((ix) => !ix.unique).map((ix) => indexLabel(t, ix));
}
