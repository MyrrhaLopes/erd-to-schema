import type { Cardinality, EntityMeta, Format, Id, Project, SchemaModel, Table } from '../types';
import { columnById, tableById } from '../schema';
import { newId } from '../naming';

export interface Diagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** Resultado de parse de um formato: modelo com IDs novos + metadados expressos no texto */
export interface ParsedSchema {
  schema: SchemaModel;
  meta: Record<Id, EntityMeta>;
  warnings: Diagnostic[];
}

export type ParseOutcome = { ok: true; parsed: ParsedSchema } | { ok: false; diagnostics: Diagnostic[] };

export class ParseError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('\n'));
    this.diagnostics = diagnostics;
  }
}

export function lineOffsets(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

export function lineRange(text: string, line: number /* 1-based */): { from: number; to: number } {
  const offs = lineOffsets(text);
  const from = offs[Math.max(0, Math.min(offs.length - 1, line - 1))] ?? 0;
  const next = offs[line] ?? text.length + 1;
  return { from, to: Math.max(from, next - 1) };
}

/* ------------------------------------------------------------------ */
/* Diretivas `@erd:` — conceitos exclusivos do canvas em comentários     */
/* ------------------------------------------------------------------ */

export interface RawDirective {
  kind: 'ref' | 'tags' | 'untag';
  body: string;
  from: number;
  to: number;
}

const DIRECTIVE_RE = /^[ \t]*(?:--|\/\/\/?)[ \t]*@erd:(ref|tags|untag)\b[ \t]*(.*)$/gm;

export function scanDirectives(text: string): RawDirective[] {
  const out: RawDirective[] = [];
  for (const m of text.matchAll(DIRECTIVE_RE)) {
    out.push({ kind: m[1] as RawDirective['kind'], body: m[2].trim(), from: m.index!, to: m.index! + m[0].length });
  }
  return out;
}

const COMMENT_PREFIX: Record<Format, string> = { sql: '--', prisma: '//', drizzle: '//' };

function endpoint(schema: SchemaModel, tableId: Id, cols: Id[]): string {
  const t = tableById(schema, tableId)!;
  const name = (t.schema ? t.schema + '.' : '') + t.name;
  if (!cols.length) return name;
  return `${name}(${cols.map((c) => columnById(t, c)?.name ?? '?').join(', ')})`;
}

/** Linhas de diretiva para um projeto, já com o prefixo de comentário do formato */
export function directiveLines(project: Project, format: Format): string[] {
  const p = COMMENT_PREFIX[format];
  const lines: string[] = [];
  const { schema, meta } = project;
  for (const r of schema.relationships) {
    if (r.kind !== 'note') continue;
    if (!tableById(schema, r.fromTable) || !tableById(schema, r.toTable)) continue;
    let s = `${p} @erd:ref ${endpoint(schema, r.fromTable, r.fromColumns)} -> ${endpoint(schema, r.toTable, r.toColumns)}`;
    if (r.cardinality) s += ' ' + r.cardinality;
    if (r.label) s += ' ' + JSON.stringify(r.label);
    if (r.showReverse) {
      s += ' reverse';
      if (r.reverseCardinality) s += ' ' + r.reverseCardinality;
      if (r.reverseLabel) s += ' ' + JSON.stringify(r.reverseLabel);
    }
    lines.push(s);
  }
  for (const t of schema.tables) {
    const m = meta[t.id];
    const name = (t.schema ? t.schema + '.' : '') + t.name;
    if (m?.tags?.length) lines.push(`${p} @erd:tags ${name} ${m.tags.join(', ')}`);
    if (m?.suppressedTags?.length) lines.push(`${p} @erd:untag ${name} ${m.suppressedTags.join(', ')}`);
  }
  return lines;
}

function findTable(schema: SchemaModel, ref: string): Table | undefined {
  const parts = ref.split('.');
  const name = parts.pop()!;
  const sch = parts.length ? parts.join('.') : undefined;
  return schema.tables.find((t) => t.name === name && (t.schema ?? 'public') === (sch ?? t.schema ?? 'public'));
}

const ENDPOINT_RE = /^([A-Za-z0-9_.$"]+)\s*(?:\(([^)]*)\))?/;

/** Aplica as diretivas ao modelo recém-parseado (relações-nota + tags) */
export function applyDirectives(parsed: ParsedSchema, directives: RawDirective[]) {
  const { schema, meta } = parsed;
  for (const d of directives) {
    const warn = (message: string) => parsed.warnings.push({ from: d.from, to: d.to, severity: 'warning', message });
    if (d.kind === 'ref') {
      const [lhs, rhsRaw] = d.body.split(/\s*->\s*/);
      if (!rhsRaw) {
        warn('@erd:ref precisa de "origem -> destino"');
        continue;
      }
      const a = lhs.trim().match(ENDPOINT_RE);
      const b = rhsRaw.trim().match(ENDPOINT_RE);
      if (!a || !b) {
        warn('@erd:ref malformado');
        continue;
      }
      const rest = rhsRaw.trim().slice(b[0].length).trim();
      const from = findTable(schema, a[1].replace(/"/g, ''));
      const to = findTable(schema, b[1].replace(/"/g, ''));
      if (!from || !to) {
        warn(`@erd:ref: tabela não encontrada (${!from ? a[1] : b[1]})`);
        continue;
      }
      const cols = (t: Table, list?: string) =>
        (list ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((n) => t.columns.find((c) => c.name === n)?.id);
      const fc = cols(from, a[2]);
      const tc = cols(to, b[2]);
      if (fc.some((c) => !c) || tc.some((c) => !c)) {
        warn('@erd:ref: coluna não encontrada');
        continue;
      }
      const card = rest.match(/^(1:1|1:N|N:1|N:N|0:1|0:N)\b/i);
      const labels = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
      const hasReverse = /\breverse\b/i.test(rest);
      let reverseCard: Cardinality | undefined;
      if (hasReverse) {
        const reverseIdx = rest.search(/\breverse\b/i);
        const reversePart = rest.slice(reverseIdx + 7).trim();
        const rCardMatch = reversePart.match(/^(1:1|1:N|N:1|N:N|0:1|0:N)\b/i);
        if (rCardMatch) reverseCard = rCardMatch[1].toUpperCase() as Cardinality;
      }
      const label = labels[0];
      const reverseLabel = hasReverse ? labels[1] : undefined;
      schema.relationships.push({
        id: newId('r_'),
        kind: 'note',
        fromTable: from.id,
        fromColumns: fc as Id[],
        toTable: to.id,
        toColumns: tc as Id[],
        cardinality: card ? (card[1].toUpperCase() as Cardinality) : undefined,
        label,
        showReverse: hasReverse ? true : undefined,
        reverseLabel,
        reverseCardinality: reverseCard,
      });
    } else {
      const m = d.body.match(/^([A-Za-z0-9_.$"]+)\s+(.+)$/);
      if (!m) {
        warn(`@erd:${d.kind} precisa de "tabela tag1, tag2"`);
        continue;
      }
      const t = findTable(schema, m[1].replace(/"/g, ''));
      if (!t) {
        warn(`@erd:${d.kind}: tabela não encontrada (${m[1]})`);
        continue;
      }
      const tags = m[2]
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const entry = (meta[t.id] ??= {});
      if (d.kind === 'tags') entry.tags = [...new Set([...(entry.tags ?? []), ...tags])];
      else entry.suppressedTags = [...new Set([...(entry.suppressedTags ?? []), ...tags])];
    }
  }
}
