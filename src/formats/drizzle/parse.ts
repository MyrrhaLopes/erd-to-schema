import { transform } from 'sucrase';
import * as orm from 'drizzle-orm';
import * as core from 'drizzle-orm/pg-core';
import type { Column, EnumType, RefAction, Relationship, Table } from '../../model/types';
import { parseTypeString } from '../../model/columnType';
import { camelCase, newId, qi } from '../../model/naming';
import { applyDirectives, lineRange, scanDirectives, type Diagnostic, type ParseOutcome, type ParsedSchema } from '../common';
import { defaultFkName, defaultIndexName } from '../sql/generate';
import { drizzleChecksDefaultName } from './generate';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MODULES: Record<string, unknown> = {
  'drizzle-orm': orm,
  'drizzle-orm/pg-core': core,
};

const dialect = new core.PgDialect();

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** SQL de um objeto `sql` do Drizzle, sem qualificador de tabela e sem aspas desnecessárias */
function sqlText(s: any, tableName?: string): string {
  const q = dialect.sqlToQuery(s);
  let text = q.sql.replace(/\$(\d+)/g, (_m, i) => literal(q.params[Number(i) - 1]));
  if (tableName) text = text.split(`"${tableName.replace(/"/g, '""')}".`).join('');
  return unquoteIdents(text);
}

function unquoteIdents(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const j = end < 0 ? text.length : end + 1;
      out += text.slice(i, j);
      i = j;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) {
        out += text.slice(i);
        break;
      }
      const ident = text.slice(i + 1, end);
      out += qi(ident);
      i = end + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function defaultOf(col: any, tableName: string): string | undefined {
  if (!col.hasDefault || col.default === undefined) return undefined;
  const d = col.default;
  if (orm.is(d, orm.SQL)) return sqlText(d, tableName);
  if (Array.isArray(d)) {
    const items = d.map((x) => (typeof x === 'string' ? `"${x.replace(/"/g, '\\"')}"` : String(x)));
    return `'{${items.join(',')}}'`;
  }
  // numeric no Drizzle usa string: `.default('1.5')`
  if (typeof d === 'string' && /^-?\d+(\.\d+)?$/.test(d) && /^(numeric|decimal)/i.test(col.getSQLType())) return d;
  return literal(d);
}

const errorLine = (e: any): number | undefined => {
  const m = String(e?.stack ?? '').match(/<anonymous>:(\d+):(\d+)/);
  if (m) return Number(m[1]) - 2; // `new Function` adiciona 2 linhas de cabeçalho
  const s = String(e?.message ?? '').match(/\((\d+):(\d+)\)/);
  if (s) return Number(s[1]);
  return undefined;
};

/** Executa o schema Drizzle (TS) e devolve os exports. Deve rodar num worker. */
export function evaluateDrizzle(text: string): Record<string, unknown> {
  const code = transform(text, { transforms: ['typescript', 'imports'], production: true }).code;
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const req = (name: string) => {
    if (name in MODULES) return MODULES[name];
    throw new Error(`import "${name}" não é permitido: só drizzle-orm e drizzle-orm/pg-core estão disponíveis`);
  };
  new Function('require', 'exports', 'module', code)(req, exports, module);
  return module.exports;
}

export function parseDrizzle(text: string): ParseOutcome {
  let exp: Record<string, unknown>;
  try {
    exp = evaluateDrizzle(text);
  } catch (e: any) {
    const line = errorLine(e);
    const range = line ? lineRange(text, line) : { from: 0, to: Math.min(1, text.length) };
    return { ok: false, diagnostics: [{ ...range, severity: 'error', message: String(e?.message ?? e) }] };
  }

  const warnings: Diagnostic[] = [];
  const whole = { from: 0, to: Math.min(1, text.length) };
  const enums: EnumType[] = [];
  const tables: Table[] = [];
  const meta: ParsedSchema['meta'] = {};
  const tableByDrizzle = new Map<any, Table>();
  const pending: { table: Table; cfg: any }[] = [];

  for (const [key, value] of Object.entries(exp)) {
    if (core.isPgEnum(value)) {
      const e: EnumType = { id: newId('e_'), name: value.enumName, values: [...value.enumValues] };
      enums.push(e);
      if (key !== camelCase(e.name) + 'Enum') meta[e.id] = { formatNames: { drizzle: key } };
    }
  }

  for (const [key, value] of Object.entries(exp)) {
    if (!orm.is(value, core.PgTable)) continue;
    const cfg = core.getTableConfig(value as any);
    const table: Table = {
      id: newId('t_'),
      name: cfg.name,
      schema: cfg.schema && cfg.schema !== 'public' ? cfg.schema : undefined,
      columns: [],
      primaryKey: [],
      uniques: [],
      indexes: [],
      checks: [],
    };
    if (key !== camelCase(cfg.name)) meta[table.id] = { formatNames: { drizzle: key } };
    const keys = orm.getTableColumns(value as any) as Record<string, any>;
    const keyOf = new Map<any, string>(Object.entries(keys).map(([k, c]) => [c, k]));
    for (const c of cfg.columns as any[]) {
      const sqlType = c.getSQLType();
      const type = parseTypeString(sqlType);
      const col: Column = { id: newId('c_'), name: c.name, type, nullable: !c.notNull };
      const def = defaultOf(c, cfg.name);
      if (def !== undefined) col.default = def;
      if (c.isUnique) col.unique = true;
      if (c.generatedIdentity) col.identity = c.generatedIdentity.type === 'byDefault' ? 'by-default' : 'always';
      if (c.primary) {
        table.primaryKey = [col.id];
        col.nullable = false;
      }
      if (c.generated) warnings.push({ ...whole, severity: 'info', message: `Coluna gerada ${cfg.name}.${c.name}: expressão ignorada` });
      const k = keyOf.get(c);
      if (k && k !== camelCase(c.name)) meta[col.id] = { formatNames: { drizzle: k } };
      table.columns.push(col);
    }
    // colunas do callback de config são objetos distintos: casar por nome
    const byName = (c: any) => table.columns.find((x) => x.name === c?.name);
    for (const pk of cfg.primaryKeys as any[]) {
      table.primaryKey = pk.columns.map((c: any) => byName(c)?.id).filter(Boolean);
      for (const id of table.primaryKey) table.columns.find((c) => c.id === id)!.nullable = false;
      if (pk.name) table.primaryKeyName = pk.name;
    }
    for (const u of cfg.uniqueConstraints as any[]) {
      const ids = u.columns.map((c: any) => byName(c)?.id).filter(Boolean);
      const dflt = `${cfg.name}_${u.columns.map((c: any) => c.name).join('_')}_unique`;
      table.uniques.push({ id: newId('u_'), name: u.name && u.name !== dflt ? u.name : undefined, columns: ids });
    }
    cfg.checks.forEach((k: any, idx: number) => {
      table.checks.push({
        id: newId('k_'),
        name: k.name === drizzleChecksDefaultName(table, idx) ? undefined : k.name,
        expr: sqlText(k.value, cfg.name),
      });
    });
    for (const ix of cfg.indexes as any[]) {
      const c = ix.config;
      const cols: (Column | undefined)[] = (c.columns ?? []).map((x: any) =>
        orm.is(x, orm.SQL) ? undefined : table.columns.find((col) => col.name === x?.name),
      );
      if (cols.some((x: any) => !x)) {
        warnings.push({ ...whole, severity: 'warning', message: `Índice de expressão "${c.name}" ainda não é suportado (ignorado)` });
        continue;
      }
      const ids = cols.map((x) => x!.id);
      const idx = {
        id: newId('i_'),
        name: c.name,
        columns: ids,
        unique: !!c.unique,
        where: c.where ? sqlText(c.where, cfg.name) : undefined,
        method: c.method && c.method !== 'btree' ? c.method : undefined,
      };
      if (idx.name === defaultIndexName(table, ids, idx.unique)) idx.name = undefined;
      table.indexes.push(idx);
    }
    tables.push(table);
    tableByDrizzle.set(value, table);
    pending.push({ table, cfg });
  }

  const relationships: Relationship[] = [];
  const schemaSoFar = { tables, enums, relationships };
  for (const { table, cfg } of pending) {
    for (const fk of cfg.foreignKeys as any[]) {
      const ref = fk.reference();
      const target = tableByDrizzle.get(ref.foreignTable);
      if (!target) {
        warnings.push({ ...whole, severity: 'warning', message: `FK de ${table.name} aponta para tabela não exportada` });
        continue;
      }
      const fromCols = ref.columns.map((c: any) => table.columns.find((x) => x.name === c.name)?.id);
      const toCols = ref.foreignColumns.map((c: any) => target.columns.find((x) => x.name === c.name)?.id);
      if ([...fromCols, ...toCols].some((x) => !x)) {
        warnings.push({ ...whole, severity: 'warning', message: `FK de ${table.name} com colunas inválidas (ignorada)` });
        continue;
      }
      const r: Relationship = {
        id: newId('r_'),
        kind: 'fk',
        name: ref.name,
        fromTable: table.id,
        fromColumns: fromCols,
        toTable: target.id,
        toColumns: toCols,
        onDelete: (fk.onDelete ?? 'no action') as RefAction,
        onUpdate: (fk.onUpdate ?? 'no action') as RefAction,
      };
      if (r.name === defaultFkName(schemaSoFar, r)) r.name = undefined;
      relationships.push(r);
    }
  }

  const parsed: ParsedSchema = { schema: { tables, enums, relationships }, meta, warnings };
  applyDirectives(parsed, scanDirectives(text));
  return { ok: true, parsed };
}
