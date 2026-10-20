import type { ColumnType } from './types';

const SYNONYMS: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  int2: 'smallint',
  smallint: 'smallint',
  int8: 'bigint',
  bigint: 'bigint',
  serial4: 'serial',
  serial: 'serial',
  serial2: 'smallserial',
  smallserial: 'smallserial',
  serial8: 'bigserial',
  bigserial: 'bigserial',
  bool: 'boolean',
  boolean: 'boolean',
  float4: 'real',
  real: 'real',
  float8: 'double precision',
  'double precision': 'double precision',
  float: 'double precision',
  decimal: 'numeric',
  numeric: 'numeric',
  'character varying': 'varchar',
  varchar: 'varchar',
  character: 'char',
  char: 'char',
  bpchar: 'char',
  text: 'text',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'jsonb',
  bytea: 'bytea',
  date: 'date',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  time: 'time',
  timetz: 'timetz',
  interval: 'interval',
  inet: 'inet',
  cidr: 'cidr',
  macaddr: 'macaddr',
  money: 'money',
  xml: 'xml',
  citext: 'citext',
  point: 'point',
  line: 'line',
  tsvector: 'tsvector',
};

export const COMMON_TYPES = [
  'serial',
  'bigserial',
  'integer',
  'bigint',
  'smallint',
  'text',
  'varchar(255)',
  'char(1)',
  'boolean',
  'uuid',
  'numeric(10,2)',
  'real',
  'double precision',
  'date',
  'timestamp',
  'timestamptz',
  'time',
  'interval',
  'json',
  'jsonb',
  'bytea',
];

/** Normaliza um nome de tipo base (já em minúsculas, sem args) */
export function normalizeBase(name: string): string {
  const lower = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return SYNONYMS[lower] ?? name.trim();
}

export function isBuiltinType(base: string) {
  return Object.prototype.hasOwnProperty.call(SYNONYMS, base.toLowerCase());
}

/**
 * Converte uma string de tipo (`varchar(255)`, `timestamp (3) with time zone`,
 * `integer[]`, `"Mood"`) para a forma canônica.
 */
export function parseTypeString(input: string): ColumnType {
  let s = input.trim();
  let array = false;
  while (/\[\s*\d*\s*\]$/.test(s)) {
    array = true;
    s = s.replace(/\[\s*\d*\s*\]$/, '').trim();
  }
  if (/^array$/i.test(s)) s = 'text';
  let tz: 'with' | 'without' | undefined;
  const tzMatch = s.match(/\s+(with|without)\s+time\s+zone$/i);
  if (tzMatch) {
    tz = tzMatch[1].toLowerCase() as 'with' | 'without';
    s = s.slice(0, tzMatch.index).trim();
  }
  let args: number[] | undefined;
  const argMatch = s.match(/\(\s*([^)]*)\)\s*$/);
  if (argMatch) {
    args = argMatch[1]
      .split(',')
      .map((a) => Number(a.trim()))
      .filter((n) => !Number.isNaN(n));
    s = s.slice(0, argMatch.index).trim();
  }
  if (/^".*"$/.test(s)) s = s.slice(1, -1).replace(/""/g, '"');
  else if (s.includes('.')) {
    const parts = s.split('.');
    if (parts[0].toLowerCase() === 'pg_catalog' || parts[0].toLowerCase() === 'public') s = parts.slice(1).join('.');
    s = s.replace(/"/g, '');
  }
  let base = normalizeBase(s);
  if (tz === 'with') {
    if (base === 'timestamp') base = 'timestamptz';
    if (base === 'time') base = 'timetz';
  }
  const t: ColumnType = { base };
  if (args && args.length) t.args = args;
  if (array) t.array = true;
  return t;
}

export function formatType(t: ColumnType, quote?: (n: string) => string): string {
  const base = quote && !isBuiltinType(t.base) ? quote(t.base) : t.base;
  return base + (t.args?.length ? `(${t.args.join(',')})` : '') + (t.array ? '[]' : '');
}

export function typeEquals(a: ColumnType, b: ColumnType) {
  return formatType(a) === formatType(b);
}

/** Tipo que um FK deve ter para apontar para uma coluna deste tipo */
export function fkTypeFor(t: ColumnType): ColumnType {
  if (t.base === 'serial') return { base: 'integer' };
  if (t.base === 'bigserial') return { base: 'bigint' };
  if (t.base === 'smallserial') return { base: 'smallint' };
  return { ...t, array: false };
}
