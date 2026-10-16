import { deparseSync } from 'pgsql-deparser';
import type { Column, ColumnType, EnumType, RefAction, Table } from '../../model/types';
import { normalizeBase } from '../../model/columnType';
import { newId } from '../../model/naming';
import { tableKey } from '../../model/schema';
import { applyDirectives, scanDirectives, type Diagnostic, type ParseOutcome, type ParsedSchema } from '../common';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;
export type PgParse = (sql: string) => Promise<{ stmts?: Node[] }>;

const ACTIONS: Record<string, RefAction> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

function byteToCharMapper(text: string): (byte: number) => number {
  if (!/[^\x00-\x7f]/.test(text)) return (b) => b;
  const map: number[] = [];
  const enc = new TextEncoder();
  let byte = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    const len = enc.encode(String.fromCodePoint(cp)).length;
    for (let k = 0; k < len; k++) map[byte + k] = i;
    byte += len;
    if (cp > 0xffff) i++;
  }
  map[byte] = text.length;
  return (b) => map[b] ?? text.length;
}

const str = (n: Node): string => n?.String?.sval ?? '';

function expr(n: Node): string {
  try {
    return deparseSync(n, { pretty: false } as never).trim();
  } catch {
    return '';
  }
}

function intConst(n: Node): number | undefined {
  const c = n?.A_Const;
  if (!c) return undefined;
  if (c.ival) return c.ival.ival ?? 0;
  if (c.fval) return Number(c.fval.fval);
  return undefined;
}

function typeOf(tn: Node): ColumnType {
  const names: string[] = (tn.names ?? []).map(str);
  if (names[0] === 'pg_catalog' && names.length > 1) names.shift();
  if (names[0] === 'public' && names.length > 1) names.shift();
  const base = normalizeBase(names.join('.'));
  const t: ColumnType = { base };
  if (base !== 'interval' && tn.typmods?.length) {
    const args = tn.typmods.map(intConst).filter((x: number | undefined): x is number => x !== undefined);
    if (args.length) t.args = args;
  }
  if (tn.arrayBounds?.length) t.array = true;
  return t;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanBlockComment(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim().replace(/^\*\s?/, '').trim())
    .filter(Boolean)
    .join('\n');
}

function extractSqlCommentFromLine(line: string): string | undefined {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      if (inString && line[i + 1] === "'") {
        i++;
      } else {
        inString = !inString;
      }
    } else if (!inString) {
      if (ch === '-' && line[i + 1] === '-') {
        const comment = line.slice(i + 2).trim();
        return comment || undefined;
      }
      if (ch === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        const comment = (end >= 0 ? line.slice(i + 2, end) : line.slice(i + 2)).trim();
        return cleanBlockComment(comment) || undefined;
      }
    }
  }
  return undefined;
}

function extractColumnComments(bodyText: string, columns: Column[]): Map<string, string> {
  const result = new Map<string, string>();
  const lines = bodyText.split('\n');
  let pendingComments: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    if (trimmed.startsWith('--')) {
      const c = trimmed.slice(2).trim();
      if (!/@erd:/.test(c) && c) pendingComments.push(c);
      continue;
    }

    if (trimmed.startsWith('/*')) {
      let blockContent = '';
      if (trimmed.endsWith('*/') && trimmed.length >= 4) {
        blockContent = trimmed.slice(2, -2);
      } else {
        const blockLines = [trimmed.slice(2)];
        while (++i < lines.length) {
          const bl = lines[i];
          const endIdx = bl.indexOf('*/');
          if (endIdx >= 0) {
            blockLines.push(bl.slice(0, endIdx));
            break;
          }
          blockLines.push(bl);
        }
        blockContent = blockLines.join('\n');
      }
      const cleaned = cleanBlockComment(blockContent);
      if (cleaned && !/@erd:/.test(cleaned)) pendingComments.push(cleaned);
      continue;
    }

    let matchedCol: Column | undefined;
    for (const col of columns) {
      const escaped = escapeRegex(col.name);
      const pattern = new RegExp(`^\\s*(?:"${escaped}"|\`${escaped}\`|${escaped})\\b`, 'i');
      if (pattern.test(rawLine)) {
        matchedCol = col;
        break;
      }
    }

    if (matchedCol) {
      const inline = extractSqlCommentFromLine(rawLine);
      const docs = [...pendingComments];
      if (inline && !/@erd:/.test(inline) && !docs.includes(inline)) {
        docs.push(inline);
      }
      if (docs.length > 0) {
        result.set(matchedCol.name, docs.join('\n'));
      }
      pendingComments = [];
    } else if (/^\s*(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(trimmed)) {
      pendingComments = [];
    }
  }

  return result;
}

function extractTableComments(text: string, sFrom: number, sTo: number): string | undefined {
  const commentBefore = extractCommentsBefore(text, sFrom);
  const commentAfter = extractCommentsAfter(text, sTo);
  const parts = [commentBefore, commentAfter].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

function extractCommentsBefore(text: string, fromOffset: number): string | undefined {
  const beforeText = text.slice(0, fromOffset);
  const lines = beforeText.split('\n');
  const commentLines: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (commentLines.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('--')) {
      const c = trimmed.slice(2).trim();
      if (!/@erd:/.test(c) && c) commentLines.unshift(c);
    } else if (trimmed.endsWith('*/')) {
      const blockLines: string[] = [];
      const startIdx = trimmed.lastIndexOf('/*');
      if (startIdx >= 0) {
        const c = cleanBlockComment(trimmed.slice(startIdx + 2, -2));
        if (c && !/@erd:/.test(c)) commentLines.unshift(c);
      } else {
        blockLines.unshift(trimmed.slice(0, -2));
        let foundStart = false;
        while (--i >= 0) {
          const bl = lines[i].trim();
          const sIdx = bl.indexOf('/*');
          if (sIdx >= 0) {
            blockLines.unshift(bl.slice(sIdx + 2));
            foundStart = true;
            break;
          }
          blockLines.unshift(bl);
        }
        if (foundStart) {
          const c = cleanBlockComment(blockLines.join('\n'));
          if (c && !/@erd:/.test(c)) commentLines.unshift(c);
        }
      }
    } else {
      break;
    }
  }

  return commentLines.length ? commentLines.join('\n') : undefined;
}

function extractCommentsAfter(text: string, toOffset: number): string | undefined {
  const afterText = text.slice(toOffset);
  const lines = afterText.split('\n');
  const commentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let trimmed = lines[i].trim();
    if (trimmed.startsWith(';')) {
      trimmed = trimmed.slice(1).trim();
    }
    if (!trimmed) {
      if (commentLines.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('--')) {
      const c = trimmed.slice(2).trim();
      if (!/@erd:/.test(c) && c) commentLines.push(c);
    } else if (trimmed.startsWith('/*')) {
      let blockContent = '';
      if (trimmed.endsWith('*/') && trimmed.length >= 4) {
        blockContent = trimmed.slice(2, -2);
      } else {
        const blockLines = [trimmed.slice(2)];
        while (++i < lines.length) {
          const bl = lines[i];
          const endIdx = bl.indexOf('*/');
          if (endIdx >= 0) {
            blockLines.push(bl.slice(0, endIdx));
            break;
          }
          blockLines.push(bl);
        }
        blockContent = blockLines.join('\n');
      }
      const c = cleanBlockComment(blockContent);
      if (c && !/@erd:/.test(c)) commentLines.push(c);
    } else {
      break;
    }
  }

  return commentLines.length ? commentLines.join('\n') : undefined;
}

interface PendingFk {
  table: Table;
  fromCols: string[];
  pkSchema?: string;
  pkTable: string;
  pkCols: string[];
  name?: string;
  onDelete?: RefAction;
  onUpdate?: RefAction;
  from: number;
  to: number;
}

export async function parseSql(text: string, pgParse: PgParse): Promise<ParseOutcome> {
  const toChar = byteToCharMapper(text);
  let ast: { stmts?: Node[] };
  try {
    ast = await pgParse(text);
  } catch (e: any) {
    const pos = e?.sqlDetails?.cursorPosition;
    let from = typeof pos === 'number' && pos > 0 ? toChar(pos - 1) : 0;
    if (from >= text.length) from = Math.max(0, text.length - 1);
    let to = from;
    while (to < text.length && /[\w"]/.test(text[to])) to++;
    return { ok: false, diagnostics: [{ from, to: Math.max(to, from + 1), severity: 'error', message: e?.message ?? String(e) }] };
  }

  const tables = new Map<string, Table>();
  const enums: EnumType[] = [];
  const fks: PendingFk[] = [];
  const warnings: Diagnostic[] = [];

  const findTable = (rel: Node): Table | undefined => {
    const k = tableKey({ name: rel.relname, schema: rel.schemaname });
    if (tables.has(k)) return tables.get(k);
    if (!rel.schemaname) {
      const matches = [...tables.values()].filter((t) => t.name === rel.relname);
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  };

  for (const raw of ast.stmts ?? []) {
    const sFrom = toChar(raw.stmt_location ?? 0);
    const sTo = toChar((raw.stmt_location ?? 0) + (raw.stmt_len ?? 0)) || text.length;
    const range = { from: sFrom, to: sTo };
    const warn = (message: string, severity: Diagnostic['severity'] = 'warning') =>
      warnings.push({ ...range, severity, message });
    const stmt = raw.stmt;
    const kind = Object.keys(stmt)[0];
    const s = stmt[kind];

    const addConstraint = (table: Table, c: Node, colName?: string) => {
      const col = colName ? table.columns.find((x) => x.name === colName) : undefined;
      switch (c.contype) {
        case 'CONSTR_NOTNULL':
          if (col) col.nullable = false;
          break;
        case 'CONSTR_NULL':
          if (col) col.nullable = true;
          break;
        case 'CONSTR_DEFAULT':
          if (col) col.default = expr(c.raw_expr);
          break;
        case 'CONSTR_IDENTITY':
          if (col) col.identity = c.generated_when === 'd' ? 'by-default' : 'always';
          break;
        case 'CONSTR_GENERATED':
          warn(`Coluna gerada "${colName}" não é suportada; a expressão foi ignorada`);
          break;
        case 'CONSTR_PRIMARY': {
          const keys: string[] = col ? [col.name] : (c.keys ?? []).map(str);
          table.primaryKey = keys
            .map((k) => table.columns.find((x) => x.name === k)?.id)
            .filter((x): x is string => !!x);
          if (c.conname) table.primaryKeyName = c.conname;
          break;
        }
        case 'CONSTR_UNIQUE': {
          if (col && !c.conname) col.unique = true;
          else {
            const keys: string[] = col ? [col.name] : (c.keys ?? []).map(str);
            const ids = keys.map((k) => table.columns.find((x) => x.name === k)?.id).filter((x): x is string => !!x);
            if (ids.length === 1 && !c.conname) table.columns.find((x) => x.id === ids[0])!.unique = true;
            else table.uniques.push({ id: newId('u_'), name: c.conname, columns: ids });
          }
          break;
        }
        case 'CONSTR_CHECK':
          table.checks.push({ id: newId('k_'), name: c.conname, expr: expr(c.raw_expr) });
          break;
        case 'CONSTR_FOREIGN':
          fks.push({
            table,
            fromCols: col ? [col.name] : (c.fk_attrs ?? []).map(str),
            pkSchema: c.pktable?.schemaname,
            pkTable: c.pktable?.relname,
            pkCols: (c.pk_attrs ?? []).map(str),
            name: c.conname,
            onDelete: ACTIONS[c.fk_del_action] ?? 'no action',
            onUpdate: ACTIONS[c.fk_upd_action] ?? 'no action',
            ...range,
          });
          break;
        default:
          warn(`Constraint ${String(c.contype).replace('CONSTR_', '')} não suportada (ignorada)`, 'info');
      }
    };

    const addColumn = (table: Table, cd: Node) => {
      const col: Column = { id: newId('c_'), name: cd.colname, type: typeOf(cd.typeName), nullable: true };
      table.columns.push(col);
      for (const c of cd.constraints ?? []) addConstraint(table, c.Constraint, col.name);
    };

    switch (kind) {
      case 'CreateStmt': {
        const t: Table = {
          id: newId('t_'),
          name: s.relation.relname,
          schema: s.relation.schemaname && s.relation.schemaname !== 'public' ? s.relation.schemaname : undefined,
          columns: [],
          primaryKey: [],
          uniques: [],
          indexes: [],
          checks: [],
        };
        const tableComment = extractTableComments(text, sFrom, sTo);
        if (tableComment) t.comment = tableComment;
        if (tables.has(tableKey(t))) warn(`Tabela "${t.name}" definida mais de uma vez`, 'error');
        tables.set(tableKey(t), t);
        for (const el of s.tableElts ?? []) {
          if (el.ColumnDef) addColumn(t, el.ColumnDef);
          else if (el.Constraint) addConstraint(t, el.Constraint);
        }
        const stmtText = text.slice(sFrom, sTo);
        const openParen = stmtText.indexOf('(');
        const closeParen = stmtText.lastIndexOf(')');
        if (openParen >= 0 && closeParen > openParen) {
          const body = stmtText.slice(openParen + 1, closeParen);
          const colComments = extractColumnComments(body, t.columns);
          for (const col of t.columns) {
            const cc = colComments.get(col.name);
            if (cc) col.comment = cc;
          }
        }
        break;
      }
      case 'AlterTableStmt': {
        const t = findTable(s.relation);
        if (!t) {
          warn(`ALTER TABLE: tabela "${s.relation.relname}" não encontrada`);
          break;
        }
        for (const c of s.cmds ?? []) {
          const cmd = c.AlterTableCmd;
          const col = cmd.name ? t.columns.find((x) => x.name === cmd.name) : undefined;
          switch (cmd.subtype) {
            case 'AT_AddConstraint':
              addConstraint(t, cmd.def.Constraint);
              break;
            case 'AT_AddColumn':
              addColumn(t, cmd.def.ColumnDef);
              break;
            case 'AT_DropColumn':
              t.columns = t.columns.filter((x) => x.name !== cmd.name);
              break;
            case 'AT_SetNotNull':
              if (col) col.nullable = false;
              break;
            case 'AT_DropNotNull':
              if (col) col.nullable = true;
              break;
            case 'AT_ColumnDefault':
              if (col) col.default = cmd.def ? expr(cmd.def) : undefined;
              break;
            case 'AT_AlterColumnType':
              if (col && cmd.def?.ColumnDef?.typeName) col.type = typeOf(cmd.def.ColumnDef.typeName);
              break;
            case 'AT_DropConstraint':
              t.checks = t.checks.filter((k) => k.name !== cmd.name);
              t.uniques = t.uniques.filter((k) => k.name !== cmd.name);
              for (let i = fks.length - 1; i >= 0; i--) if (fks[i].table === t && fks[i].name === cmd.name) fks.splice(i, 1);
              break;
            default:
              warn(`ALTER TABLE ${String(cmd.subtype).replace('AT_', '')} ignorado`, 'info');
          }
        }
        break;
      }
      case 'IndexStmt': {
        const t = findTable(s.relation);
        if (!t) {
          warn(`CREATE INDEX: tabela "${s.relation.relname}" não encontrada`);
          break;
        }
        const params = (s.indexParams ?? []).map((p: Node) => p.IndexElem);
        if (params.some((p: Node) => !p.name)) {
          warn('Índices de expressão ainda não são suportados (ignorado)');
          break;
        }
        const ids = params.map((p: Node) => t.columns.find((c) => c.name === p.name)?.id);
        if (ids.some((x: string | undefined) => !x)) {
          warn('CREATE INDEX referencia coluna inexistente');
          break;
        }
        t.indexes.push({
          id: newId('i_'),
          name: s.idxname,
          columns: ids,
          unique: !!s.unique,
          where: s.whereClause ? expr(s.whereClause) : undefined,
          method: s.accessMethod && s.accessMethod !== 'btree' ? s.accessMethod : undefined,
        });
        break;
      }
      case 'CreateEnumStmt': {
        const names: string[] = s.typeName.map(str);
        const name = names.pop()!;
        const schema = names.length && names[0] !== 'public' ? names[0] : undefined;
        enums.push({ id: newId('e_'), name, schema, values: (s.vals ?? []).map(str) });
        break;
      }
      case 'CommentStmt': {
        const items: string[] = (s.object?.List?.items ?? []).map(str);
        if (s.objtype === 'OBJECT_TABLE') {
          const name = items.pop()!;
          const t = findTable({ relname: name, schemaname: items[0] });
          if (t) t.comment = s.comment ?? undefined;
          else warn(`COMMENT: tabela "${name}" não encontrada`);
        } else if (s.objtype === 'OBJECT_COLUMN') {
          const colName = items.pop()!;
          const tname = items.pop()!;
          const t = findTable({ relname: tname, schemaname: items[0] });
          const col = t?.columns.find((c) => c.name === colName);
          if (col) col.comment = s.comment ?? undefined;
          else warn(`COMMENT: coluna "${tname}.${colName}" não encontrada`);
        } else warn('COMMENT ignorado', 'info');
        break;
      }
      case 'CreateSchemaStmt':
      case 'CreateExtensionStmt':
      case 'VariableSetStmt':
      case 'TransactionStmt':
        break;
      default:
        warn(`Statement ${kind} ignorado`, 'info');
    }
  }

  // PK implica NOT NULL
  for (const t of tables.values()) for (const c of t.columns) if (t.primaryKey.includes(c.id)) c.nullable = false;

  const parsed: ParsedSchema = {
    schema: { tables: [...tables.values()], enums, relationships: [] },
    meta: {},
    warnings,
  };

  for (const fk of fks) {
    const target = findTableIn(tables, fk.pkTable, fk.pkSchema);
    if (!target) {
      warnings.push({ from: fk.from, to: fk.to, severity: 'warning', message: `FOREIGN KEY: tabela "${fk.pkTable}" não encontrada` });
      continue;
    }
    const toCols = fk.pkCols.length ? fk.pkCols.map((n) => target.columns.find((c) => c.name === n)?.id) : target.primaryKey;
    const fromCols = fk.fromCols.map((n) => fk.table.columns.find((c) => c.name === n)?.id);
    if (toCols.some((x) => !x) || fromCols.some((x) => !x) || toCols.length !== fromCols.length || !toCols.length) {
      warnings.push({ from: fk.from, to: fk.to, severity: 'warning', message: 'FOREIGN KEY com colunas inválidas (ignorada)' });
      continue;
    }
    parsed.schema.relationships.push({
      id: newId('r_'),
      kind: 'fk',
      name: fk.name,
      fromTable: fk.table.id,
      fromColumns: fromCols as string[],
      toTable: target.id,
      toColumns: toCols as string[],
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    });
  }

  applyDirectives(parsed, scanDirectives(text));
  return { ok: true, parsed };
}

function findTableIn(tables: Map<string, Table>, name: string, schema?: string) {
  const k = tableKey({ name, schema });
  if (tables.has(k)) return tables.get(k);
  if (!schema) {
    const m = [...tables.values()].filter((t) => t.name === name);
    if (m.length === 1) return m[0];
  }
  return undefined;
}
