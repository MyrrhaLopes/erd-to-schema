import type { Column, Project, RefAction, SchemaModel, Table } from '../../model/types';
import { formatType } from '../../model/columnType';
import { camelCase, isValidJsIdent, uniqueName } from '../../model/naming';
import { tableById } from '../../model/schema';
import { directiveLines } from '../common';
import { defaultFkName, defaultIndexName } from '../sql/generate';

const JS_RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await sql'.split(
    ' ',
  ),
);

export interface DrizzleNames {
  table: Map<string, string>;
  enumVar: Map<string, string>; // enum db name -> var
  key: Map<string, string>; // column id -> key
}

const safeVar = (s: string) => (JS_RESERVED.has(s) || !isValidJsIdent(s) ? s + '_' : s);
const prop = (k: string) => (isValidJsIdent(k) ? k : JSON.stringify(k));
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const sqlTpl = (s: string) => 'sql`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';

export function computeDrizzleNames(project: Pick<Project, 'schema' | 'meta'>): DrizzleNames {
  const { schema, meta } = project;
  const used = new Set<string>(['sql', 'raw']);
  const n: DrizzleNames = { table: new Map(), enumVar: new Map(), key: new Map() };
  for (const e of schema.enums) {
    const v = uniqueName(safeVar(meta[e.id]?.formatNames?.drizzle ?? camelCase(e.name) + 'Enum'), used);
    used.add(v);
    n.enumVar.set(e.name, v);
  }
  for (const t of schema.tables) {
    const v = uniqueName(safeVar(meta[t.id]?.formatNames?.drizzle ?? camelCase(t.name)), used);
    used.add(v);
    n.table.set(t.id, v);
    const keys = new Set<string>();
    for (const c of t.columns) {
      const k = uniqueName(meta[c.id]?.formatNames?.drizzle ?? camelCase(c.name), keys);
      keys.add(k);
      n.key.set(c.id, k);
    }
  }
  return n;
}

const INT_TYPES = new Set(['smallint', 'integer', 'bigint', 'serial', 'smallserial', 'bigserial', 'real', 'double precision']);
const TEXT_TYPES = new Set(['text', 'varchar', 'char', 'uuid', 'inet', 'cidr', 'macaddr', 'interval', 'date', 'time', 'timetz']);

/** Construtor da coluna (sem `.references`) */
export function drizzleColumnExpr(c: Column, schema: SchemaModel, enumVar: (name: string) => string | undefined, used: Set<string>): string {
  const t = c.type;
  const a = t.args ?? [];
  const n = str(c.name);
  let b: string;
  const use = (fn: string) => {
    used.add(fn);
    return fn;
  };
  const ev = schema.enums.some((e) => e.name === t.base) ? enumVar(t.base) : undefined;
  if (ev) b = `${ev}(${n})`;
  else
    switch (t.base) {
      case 'bigint':
      case 'bigserial':
        b = `${use(t.base)}(${n}, { mode: 'number' })`;
        break;
      case 'smallint':
      case 'integer':
      case 'serial':
      case 'smallserial':
      case 'text':
      case 'boolean':
      case 'uuid':
      case 'json':
      case 'jsonb':
      case 'date':
      case 'real':
      case 'inet':
      case 'cidr':
      case 'macaddr':
      case 'interval':
        b = `${use(t.base)}(${n})`;
        break;
      case 'double precision':
        b = `${use('doublePrecision')}(${n})`;
        break;
      case 'varchar':
      case 'char':
        b = a.length ? `${use(t.base)}(${n}, { length: ${a[0]} })` : `${use(t.base)}(${n})`;
        break;
      case 'numeric':
        b = a.length
          ? `${use('numeric')}(${n}, { precision: ${a[0]}${a.length > 1 ? `, scale: ${a[1]}` : ''} })`
          : `${use('numeric')}(${n})`;
        break;
      case 'timestamp':
      case 'timestamptz':
      case 'time':
      case 'timetz': {
        const fn = t.base.startsWith('timestamp') ? 'timestamp' : 'time';
        const opts: string[] = [];
        if (a.length) opts.push(`precision: ${a[0]}`);
        if (t.base.endsWith('tz')) opts.push('withTimezone: true');
        b = `${use(fn)}(${n}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
        break;
      }
      default:
        used.add('customType');
        used.add('__raw');
        b = `raw(${str(formatType({ base: t.base, args: t.args }))})(${n})`;
    }
  if (t.array) b += '.array()';
  return b + columnModifiers(c);
}

function columnModifiers(c: Column): string {
  let s = '';
  if (c.identity) s += c.identity === 'always' ? '.generatedAlwaysAsIdentity()' : '.generatedByDefaultAsIdentity()';
  if (c.default !== undefined && c.default !== '') s += defaultExpr(c);
  return s;
}

function defaultExpr(c: Column): string {
  const d = c.default!.trim();
  if (/^(now\(\)|current_timestamp)$/i.test(d) && !c.type.array) return '.defaultNow()';
  if (/^-?\d+(\.\d+)?$/.test(d) && !c.type.array) {
    if (INT_TYPES.has(c.type.base)) return `.default(${d})`;
    if (c.type.base === 'numeric') return `.default(${str(d)})`;
  }
  if (/^(true|false)$/i.test(d) && c.type.base === 'boolean') return `.default(${d.toLowerCase()})`;
  const lit = d.match(/^'((?:[^']|'')*)'(?:::[\w ."]+)?$/);
  if (lit && !c.type.array && !INT_TYPES.has(c.type.base) && c.type.base !== 'boolean' && c.type.base !== 'json' && c.type.base !== 'jsonb') {
    const v = lit[1].replace(/''/g, "'");
    if (TEXT_TYPES.has(c.type.base) || !['numeric', 'timestamp', 'timestamptz'].includes(c.type.base)) return `.default(${str(v)})`;
  }
  return `.default(${sqlTpl(d)})`;
}

const ACTION_JS: Record<RefAction, string> = {
  'no action': 'no action',
  restrict: 'restrict',
  cascade: 'cascade',
  'set null': 'set null',
  'set default': 'set default',
};

export function drizzleChecksDefaultName(t: Table, i: number) {
  return `${t.name}_check_${i + 1}`;
}

export function generateDrizzle(project: Pick<Project, 'schema' | 'meta'>): string {
  const { schema } = project;
  const names = computeDrizzleNames(project);
  const used = new Set<string>(['pgTable']);
  const body: string[] = [];
  let needsSql = false;

  if (schema.enums.length) used.add('pgEnum');
  for (const e of schema.enums)
    body.push(`export const ${names.enumVar.get(e.name)} = pgEnum(${str(e.name)}, [${e.values.map(str).join(', ')}]);`);

  const fks = schema.relationships.filter((r) => r.kind === 'fk' && tableById(schema, r.fromTable) && tableById(schema, r.toTable));

  for (const t of schema.tables) {
    const v = names.table.get(t.id)!;
    const lines: string[] = [];
    const singlePk = t.primaryKey.length === 1 && !t.primaryKeyName ? t.primaryKey[0] : undefined;
    const inlineFk = new Map<string, string>();
    const extra: string[] = [];
    const ref = (tid: string, cid: string) => `${names.table.get(tid)}.${names.key.get(cid)}`;
    const tref = (cid: string) => `t.${names.key.get(cid)}`;

    for (const r of fks) {
      if (r.fromTable !== t.id) continue;
      const opts: string[] = [];
      if (r.onDelete && r.onDelete !== 'no action') opts.push(`onDelete: '${ACTION_JS[r.onDelete]}'`);
      if (r.onUpdate && r.onUpdate !== 'no action') opts.push(`onUpdate: '${ACTION_JS[r.onUpdate]}'`);
      const nameIsDefault = !r.name || r.name === defaultFkName(schema, r);
      if (r.fromColumns.length === 1 && nameIsDefault && !inlineFk.has(r.fromColumns[0])) {
        const self = r.toTable === t.id;
        const target = self ? `(): AnyPgColumn => ${ref(r.toTable, r.toColumns[0])}` : `() => ${ref(r.toTable, r.toColumns[0])}`;
        if (self) used.add('AnyPgColumn');
        inlineFk.set(r.fromColumns[0], `.references(${target}${opts.length ? `, { ${opts.join(', ')} }` : ''})`);
      } else {
        used.add('foreignKey');
        let s = `foreignKey({ ${r.name && !nameIsDefault ? `name: ${str(r.name)}, ` : ''}columns: [${r.fromColumns.map(tref).join(', ')}], foreignColumns: [${r.toColumns.map((c) => ref(r.toTable, c)).join(', ')}] })`;
        if (r.onDelete && r.onDelete !== 'no action') s += `.onDelete('${r.onDelete}')`;
        if (r.onUpdate && r.onUpdate !== 'no action') s += `.onUpdate('${r.onUpdate}')`;
        extra.push(s);
      }
    }

    for (const c of t.columns) {
      let e = drizzleColumnExpr(c, schema, (n) => names.enumVar.get(n), used);
      if (c.id === singlePk) e += '.primaryKey()';
      else if (!c.nullable) e += '.notNull()';
      if (c.unique && c.id !== singlePk) e += '.unique()';
      if (inlineFk.has(c.id)) e += inlineFk.get(c.id);
      if (e.includes('sql`')) needsSql = true;
      lines.push(`  ${prop(names.key.get(c.id)!)}: ${e},`);
    }

    if (t.primaryKey.length && !singlePk) {
      used.add('primaryKey');
      extra.unshift(`primaryKey({ ${t.primaryKeyName ? `name: ${str(t.primaryKeyName)}, ` : ''}columns: [${t.primaryKey.map(tref).join(', ')}] })`);
    }
    for (const u of t.uniques) {
      used.add('unique');
      extra.push(`unique(${u.name ? str(u.name) : ''}).on(${u.columns.map(tref).join(', ')})`);
    }
    for (const i of t.indexes) {
      const fn = i.unique ? 'uniqueIndex' : 'index';
      used.add(fn);
      let s = `${fn}(${str(i.name ?? defaultIndexName(t, i.columns, i.unique))})`;
      if (i.method && i.method !== 'btree') s += `.using(${str(i.method)}, ${i.columns.map(tref).join(', ')})`;
      else s += `.on(${i.columns.map(tref).join(', ')})`;
      if (i.where) {
        s += `.where(${sqlTpl(i.where)})`;
        needsSql = true;
      }
      extra.push(s);
    }
    t.checks.forEach((k, idx) => {
      used.add('check');
      needsSql = true;
      extra.push(`check(${str(k.name ?? drizzleChecksDefaultName(t, idx))}, ${sqlTpl(k.expr)})`);
    });

    let s = `export const ${v} = pgTable(${str(t.name)}, {\n${lines.join('\n')}\n}`;
    if (extra.length) s += `, (t) => [\n${extra.map((e) => '  ' + e + ',').join('\n')}\n]`;
    s += ');';
    body.push(s);
  }

  const coreImports = [...used].filter((u) => u !== '__raw' && u !== 'AnyPgColumn').sort();
  const head: string[] = [];
  head.push(`import { ${coreImports.join(', ')} } from 'drizzle-orm/pg-core';`);
  if (used.has('AnyPgColumn')) head.push(`import type { AnyPgColumn } from 'drizzle-orm/pg-core';`);
  if (needsSql) head.push(`import { sql } from 'drizzle-orm';`);
  if (used.has('__raw')) head.push('', '/** Tipos do Postgres sem construtor nativo no Drizzle */', 'const raw = (type: string) => customType<{ data: unknown }>({ dataType: () => type });');

  const directives = directiveLines(project as Project, 'drizzle');
  const tail = directives.length ? ['// Conceitos do canvas (relações-nota e tags)', ...directives].join('\n') : '';
  return [head.join('\n'), ...body, tail].filter(Boolean).join('\n\n') + '\n';
}

/** Assinatura de coluna para reconciliação */
export function drizzleColumnSignature(c: Column, t: Table, schema: SchemaModel): string {
  const used = new Set<string>();
  let s = c.name + ':' + drizzleColumnExpr(c, schema, (n) => n, used);
  if (!c.nullable) s += '.notNull()';
  if (t.primaryKey.length === 1 && t.primaryKey[0] === c.id) s += '.pk';
  if (c.unique) s += '.unique()';
  return s;
}
