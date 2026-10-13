import { getSchema, PrismaParser, VisitorClassFactory } from '@mrleebo/prisma-ast';
import type { Column, ColumnType, EnumType, Id, RefAction, Relationship, Table } from '../../model/types';
import { camelCase, modelNameFor, newId, pascalCase } from '../../model/naming';
import { fkTypeFor, parseTypeString } from '../../model/columnType';
import { applyDirectives, scanDirectives, type Diagnostic, type ParseOutcome, type ParsedSchema } from '../common';
import { canonicalFromPrisma, cleanType, computePrismaNames } from './mapping';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

let parserInstance: { parser: PrismaParser; visitor: any } | null = null;
function parserWithLocations() {
  if (!parserInstance) {
    const parser = new PrismaParser({ nodeLocationTracking: 'full' });
    const Visitor = VisitorClassFactory(parser);
    parserInstance = { parser, visitor: new Visitor() };
  }
  return parserInstance;
}

const ACTIONS: Record<string, RefAction> = {
  NoAction: 'no action',
  Restrict: 'restrict',
  Cascade: 'cascade',
  SetNull: 'set null',
  SetDefault: 'set default',
};

const unq = (v: unknown): string => {
  if (typeof v !== 'string') return '';
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
};

const argList = (attr: Node): Node[] => (attr?.args ?? []).map((a: Node) => a.value);
const arrayNames = (v: Node): string[] =>
  v?.type === 'array' ? (v.args ?? []).map((x: Node) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : [];
const keyArg = (attr: Node, key: string): Node => argList(attr).find((v) => v?.type === 'keyValue' && v.key === key)?.value;
const positional = (attr: Node): Node[] => argList(attr).filter((v) => v?.type !== 'keyValue');

function loc(n: Node, fallback: { from: number; to: number }) {
  const l = n?.location;
  if (l && typeof l.startOffset === 'number') return { from: l.startOffset, to: (l.endOffset ?? l.startOffset) + 1 };
  return fallback;
}

function docComment(props: Node[], index: number): string | undefined {
  const lines: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const p = props[i];
    if (p?.type === 'comment' && typeof p.text === 'string' && p.text.startsWith('///')) {
      if (/@erd:/.test(p.text)) break;
      lines.unshift(p.text.replace(/^\/\/\/\s?/, ''));
    } else break;
  }
  return lines.length ? lines.join('\n') : undefined;
}

function parseDefault(v: Node, col: Column, enumValues?: Map<string, string>): { expr?: string; autoinc?: boolean; warn?: string } {
  if (v && typeof v === 'object' && v.type === 'function') {
    const params = (v.params ?? []).map(unq);
    switch (v.name) {
      case 'autoincrement':
        return { autoinc: true };
      case 'now':
        return { expr: 'now()' };
      case 'dbgenerated':
        return { expr: params[0] || undefined };
      case 'uuid':
        return { expr: 'gen_random_uuid()' };
      case 'sequence':
        return { autoinc: true };
      default:
        return { warn: `@default(${v.name}()) é gerado pelo cliente Prisma; não há equivalente no banco` };
    }
  }
  if (v && typeof v === 'object' && v.type === 'array') {
    const items = (v.args ?? []).map((x: Node) => unq(x));
    return { expr: `'{${items.join(',')}}'` };
  }
  if (typeof v === 'string') {
    if (v.startsWith('"')) return { expr: `'${unq(v).replace(/'/g, "''")}'` };
    if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') return { expr: v };
    if (enumValues?.has(v)) return { expr: `'${enumValues.get(v)!.replace(/'/g, "''")}'::${col.type.base}` };
    return { expr: `'${v}'` };
  }
  return {};
}

interface RelField {
  model: string;
  table: Table;
  field: Node;
  target: string;
  name?: string;
  fields: string[];
  references: string[];
  onDelete?: RefAction;
  onUpdate?: RefAction;
  list: boolean;
  optional: boolean;
  range: { from: number; to: number };
  used?: boolean;
}

export function parsePrisma(text: string): ParseOutcome {
  let ast: Node;
  try {
    ast = getSchema(text, parserWithLocations() as never);
  } catch (e: any) {
    const tok = e?.token;
    const from = typeof tok?.startOffset === 'number' && !Number.isNaN(tok.startOffset) ? tok.startOffset : Math.max(0, text.length - 1);
    const to = typeof tok?.endOffset === 'number' && !Number.isNaN(tok.endOffset) ? tok.endOffset + 1 : from + 1;
    const msg = String(e?.message ?? e).replace(/-->\s*/g, '').replace(/\s*<--/g, '');
    return { ok: false, diagnostics: [{ from, to, severity: 'error', message: msg }] };
  }

  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const whole = { from: 0, to: Math.min(text.length, 1) };
  const blocks: Node[] = ast.list ?? [];

  /* ---- enums ---- */
  const enums: EnumType[] = [];
  const enumByPrisma = new Map<string, { dbName: string; values: Map<string, string>; e: EnumType }>();
  const meta: ParsedSchema['meta'] = {};
  for (const b of blocks) {
    if (b.type !== 'enum') continue;
    const values = new Map<string, string>();
    let dbName = b.name;
    for (const en of b.enumerators ?? []) {
      if (en.type === 'enumerator') {
        const mapAttr = (en.attributes ?? []).find((a: Node) => a.name === 'map');
        values.set(en.name, mapAttr ? unq(positional(mapAttr)[0]) : en.name);
      } else if (en.type === 'attribute' && en.name === 'map') dbName = unq(positional(en)[0]);
    }
    const e: EnumType = { id: newId('e_'), name: dbName, values: [...values.values()] };
    enums.push(e);
    enumByPrisma.set(b.name, { dbName, values, e });
    if (b.name !== pascalCase(dbName)) meta[e.id] = { formatNames: { prisma: b.name } };
  }

  /* ---- models ---- */
  const models = blocks.filter((b) => b.type === 'model' || b.type === 'view');
  const modelNames = new Set(models.map((m) => m.name));
  const tableByModel = new Map<string, Table>();
  const fieldCol = new Map<string, Map<string, Column>>(); // model -> fieldName -> column
  const relFields: RelField[] = [];
  const tables: Table[] = [];

  for (const m of models) {
    const props: Node[] = m.properties ?? [];
    const mapAttr = props.find((p) => p.type === 'attribute' && p.kind === 'object' && p.name === 'map');
    const table: Table = {
      id: newId('t_'),
      name: mapAttr ? unq(positional(mapAttr)[0]) : m.name,
      columns: [],
      primaryKey: [],
      uniques: [],
      indexes: [],
      checks: [],
    };
    const tdoc: string[] = [];
    const bi = blocks.indexOf(m);
    for (let i = bi - 1; i >= 0; i--) {
      const c = blocks[i];
      if (c?.type === 'comment' && c.text.startsWith('///') && !/@erd:/.test(c.text)) tdoc.unshift(c.text.replace(/^\/\/\/\s?/, ''));
      else break;
    }
    if (tdoc.length) table.comment = tdoc.join('\n');
    tables.push(table);
    tableByModel.set(m.name, table);
    const cols = new Map<string, Column>();
    fieldCol.set(m.name, cols);
    if (m.name !== modelNameFor(table.name)) (meta[table.id] ??= {}).formatNames = { prisma: m.name };
    const mRange = loc(m, whole);

    props.forEach((p, idx) => {
      if (p.type !== 'field') return;
      const range = loc(p, mRange);
      const attrs: Node[] = p.attributes ?? [];
      const attr = (name: string, group?: string) => attrs.find((a) => a.name === name && (group ? a.group === group : !a.group));
      const ft = p.fieldType;
      const typeName = typeof ft === 'string' ? ft : ft?.name;

      if (typeof ft === 'string' && modelNames.has(ft)) {
        const rel = attr('relation');
        relFields.push({
          model: m.name,
          table,
          field: p,
          target: ft,
          name: rel ? unq(positional(rel)[0] ?? keyArg(rel, 'name')) || undefined : undefined,
          fields: rel ? arrayNames(keyArg(rel, 'fields')) : [],
          references: rel ? arrayNames(keyArg(rel, 'references')) : [],
          onDelete: rel ? ACTIONS[keyArg(rel, 'onDelete')] : undefined,
          onUpdate: rel ? ACTIONS[keyArg(rel, 'onUpdate')] : undefined,
          list: !!p.array,
          optional: !!p.optional,
          range,
        });
        return;
      }

      const mapA = attr('map');
      const colName = mapA ? unq(positional(mapA)[0]) : p.name;
      const dbAttr = attrs.find((a) => a.group === 'db');
      const native = dbAttr ? { name: dbAttr.name, args: positional(dbAttr).map((x) => Number(unq(x))).filter((n) => !Number.isNaN(n)) } : undefined;
      const defAttr = attr('default');
      const defVal = defAttr ? positional(defAttr)[0] : undefined;
      const autoinc = defVal?.type === 'function' && (defVal.name === 'autoincrement' || defVal.name === 'sequence');

      let type: ColumnType | null;
      const en = enumByPrisma.get(typeName);
      if (en) type = { base: en.dbName };
      else if (typeName === 'Unsupported') type = parseTypeString(unq(ft.params?.[0]));
      else type = canonicalFromPrisma(typeName, native, autoinc);
      if (!type) {
        errors.push({ ...range, severity: 'error', message: `Tipo desconhecido "${typeName}" no campo ${m.name}.${p.name}` });
        return;
      }
      type = cleanType(type);
      if (p.array) type.array = true;
      const col: Column = { id: newId('c_'), name: colName, type, nullable: !!p.optional };
      if (defAttr && defVal !== undefined) {
        const d = parseDefault(defVal, col, en?.values);
        if (d.expr) col.default = d.expr;
        if (d.warn) warnings.push({ ...range, severity: 'info', message: d.warn });
      }
      if (attr('unique')) col.unique = true;
      if (attr('id')) {
        table.primaryKey = [col.id];
        col.nullable = false;
      }
      const docs = [docComment(props, idx), typeof p.comment === 'string' && p.comment.startsWith('///') ? p.comment.replace(/^\/\/\/\s?/, '') : undefined]
        .filter(Boolean)
        .join('\n');
      if (docs) col.comment = docs;
      if (p.name !== camelCase(colName)) meta[col.id] = { formatNames: { prisma: p.name } };
      table.columns.push(col);
      cols.set(p.name, col);
    });

    // atributos de bloco
    for (const p of props) {
      if (p.type !== 'attribute' || p.kind !== 'object') continue;
      const range = loc(p, mRange);
      const colIds = (names: string[]) => {
        const ids = names.map((n) => cols.get(n)?.id);
        if (ids.some((x) => !x)) {
          errors.push({ ...range, severity: 'error', message: `@@${p.name} referencia campo inexistente em ${m.name}` });
          return null;
        }
        return ids as Id[];
      };
      const listArg = arrayNames(positional(p)[0] ?? keyArg(p, 'fields'));
      switch (p.name) {
        case 'id': {
          const ids = colIds(listArg);
          if (ids) {
            table.primaryKey = ids;
            ids.forEach((id) => (table.columns.find((c) => c.id === id)!.nullable = false));
          }
          break;
        }
        case 'unique': {
          const ids = colIds(listArg);
          if (ids) {
            if (ids.length === 1) table.columns.find((c) => c.id === ids[0])!.unique = true;
            else table.uniques.push({ id: newId('u_'), columns: ids });
          }
          break;
        }
        case 'index': {
          const ids = colIds(listArg);
          if (ids) table.indexes.push({ id: newId('i_'), columns: ids, unique: false });
          break;
        }
        case 'map':
        case 'ignore':
        case 'schema':
          break;
        default:
          warnings.push({ ...range, severity: 'info', message: `@@${p.name} ignorado` });
      }
    }
  }

  /* ---- relações ---- */
  const relationships: Relationship[] = [];
  const relFieldNames = new Map<Id, { from?: string; to?: string; name?: string }>();
  for (const rf of relFields) {
    if (!rf.fields.length) continue;
    rf.used = true;
    const target = tableByModel.get(rf.target)!;
    const fromCols = rf.fields.map((f) => fieldCol.get(rf.model)?.get(f)?.id);
    const toCols = rf.references.map((f) => fieldCol.get(rf.target)?.get(f)?.id);
    if (fromCols.some((x) => !x) || toCols.some((x) => !x) || fromCols.length !== toCols.length || !toCols.length) {
      errors.push({ ...rf.range, severity: 'error', message: `@relation(fields, references) de ${rf.model}.${rf.field.name} aponta para campos inexistentes` });
      continue;
    }
    const r: Relationship = {
      id: newId('r_'),
      kind: 'fk',
      fromTable: rf.table.id,
      fromColumns: fromCols as Id[],
      toTable: target.id,
      toColumns: toCols as Id[],
      onDelete: rf.onDelete ?? 'no action',
      onUpdate: rf.onUpdate ?? 'no action',
    };
    relationships.push(r);
    relFieldNames.set(r.id, { from: rf.field.name, name: rf.name });
    // lado oposto
    const back = relFields.find(
      (o) => !o.used && !o.fields.length && o.model === rf.target && o.target === rf.model && (o.name ?? '') === (rf.name ?? ''),
    );
    if (back) {
      back.used = true;
      relFieldNames.get(r.id)!.to = back.field.name;
    } else warnings.push({ ...rf.range, severity: 'warning', message: `Relação ${rf.model}.${rf.field.name} sem campo oposto em ${rf.target}` });
  }

  // M:N implícito: listas nos dois lados, sem fields/references
  const pivotTables: Table[] = [];
  for (const rf of relFields) {
    if (rf.used || !rf.list) continue;
    const other = relFields.find((o) => o !== rf && !o.used && o.list && o.model === rf.target && o.target === rf.model && (o.name ?? '') === (rf.name ?? ''));
    if (!other) {
      warnings.push({ ...rf.range, severity: 'warning', message: `Lista ${rf.model}.${rf.field.name} sem relação correspondente em ${rf.target}` });
      rf.used = true;
      continue;
    }
    rf.used = other.used = true;
    const [first, second] = [rf, other].sort((a, b) => (a.model < b.model ? -1 : 1));
    const ta = tableByModel.get(first.model)!;
    const tb = tableByModel.get(second.model)!;
    if (ta.primaryKey.length !== 1 || tb.primaryKey.length !== 1) {
      errors.push({ ...rf.range, severity: 'error', message: 'M:N implícito exige @id de campo único nos dois models' });
      continue;
    }
    const pkA = ta.columns.find((c) => c.id === ta.primaryKey[0])!;
    const pkB = tb.columns.find((c) => c.id === tb.primaryKey[0])!;
    const colA: Column = { id: newId('c_'), name: 'A', type: fkTypeFor(pkA.type), nullable: false };
    const colB: Column = { id: newId('c_'), name: 'B', type: fkTypeFor(pkB.type), nullable: false };
    const relName = rf.name ?? `${first.model}To${second.model}`;
    const pivot: Table = {
      id: newId('t_'),
      name: `_${relName}`,
      columns: [colA, colB],
      primaryKey: [colA.id, colB.id],
      uniques: [],
      indexes: [{ id: newId('i_'), columns: [colB.id], unique: false }],
      checks: [],
    };
    pivotTables.push(pivot);
    relationships.push(
      { id: newId('r_'), kind: 'fk', fromTable: pivot.id, fromColumns: [colA.id], toTable: ta.id, toColumns: [pkA.id], onDelete: 'cascade', onUpdate: 'cascade' },
      { id: newId('r_'), kind: 'fk', fromTable: pivot.id, fromColumns: [colB.id], toTable: tb.id, toColumns: [pkB.id], onDelete: 'cascade', onUpdate: 'cascade' },
    );
    meta[pivot.id] = {
      provenance: { kind: 'pivot', a: ta.id, b: tb.id, implicit: 'prisma' },
      formatNames: { prismaFrom: first.field.name, prismaTo: second.field.name },
    };
  }
  for (const rf of relFields)
    if (!rf.used) warnings.push({ ...rf.range, severity: 'warning', message: `Campo de relação ${rf.model}.${rf.field.name} sem par (ignorado)` });

  if (errors.length) return { ok: false, diagnostics: [...errors, ...warnings] };

  const parsed: ParsedSchema = { schema: { tables: [...tables, ...pivotTables], enums, relationships }, meta, warnings };

  // guarda nomes de campos de relação só quando diferem dos derivados
  const derived = computePrismaNames({ schema: parsed.schema, meta: stripRelNames(meta) });
  for (const [rid, n] of relFieldNames) {
    const fn: Record<string, string> = {};
    if (n.from && n.from !== derived.relFrom.get(rid)) fn.prismaFrom = n.from;
    if (n.to && n.to !== derived.relTo.get(rid)) fn.prismaTo = n.to;
    if (n.name && n.name !== derived.relName.get(rid)) fn.prismaRelation = n.name;
    if (Object.keys(fn).length) meta[rid] = { ...(meta[rid] ?? {}), formatNames: fn };
  }
  for (const p of pivotTables) {
    const fn = meta[p.id].formatNames!;
    if (fn.prismaFrom === derived.relFrom.get(p.id)) delete fn.prismaFrom;
    if (fn.prismaTo === derived.relTo.get(p.id)) delete fn.prismaTo;
    if (!Object.keys(fn).length) delete meta[p.id].formatNames;
  }

  applyDirectives(parsed, scanDirectives(text));
  return { ok: true, parsed };
}

function stripRelNames(meta: ParsedSchema['meta']): ParsedSchema['meta'] {
  const out: ParsedSchema['meta'] = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v.provenance?.kind === 'pivot') out[k] = { provenance: v.provenance };
    else out[k] = v;
  }
  return out;
}
