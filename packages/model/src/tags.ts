import type { Id, Project, SchemaModel, Table } from './types';
import { isUniqueSet, tableById } from './schema';

/** Pivot: exatamente 2 FKs cujas colunas formam a PK (ou um UNIQUE) e poucas colunas extras */
export function detectPivot(schema: SchemaModel, table: Table): { a: Id; b: Id } | null {
  const fks = schema.relationships.filter((r) => r.kind === 'fk' && r.fromTable === table.id);
  if (fks.length !== 2) return null;
  const cols = [...new Set(fks.flatMap((r) => r.fromColumns))];
  if (!isUniqueSet(table, cols)) return null;
  const extra = table.columns.filter((c) => !cols.includes(c.id) && !table.primaryKey.includes(c.id));
  if (extra.length > 2) return null;
  return { a: fks[0].toTable, b: fks[1].toTable };
}

const HISTORY_SUFFIX = /(_history|_histories|_audit|_audits|_log|_logs|_versions|_archive|history|audit)$/i;
const HISTORY_COLS = new Set([
  'valid_from',
  'valid_to',
  'valid_until',
  'changed_at',
  'changed_by',
  'operation',
  'op',
  'action',
  'version',
  'revision',
  'recorded_at',
  'archived_at',
  'event_type',
  'old_values',
  'new_values',
  'snapshot',
]);

/** Pontuação de tabela de histórico */
export function historyScore(schema: SchemaModel, table: Table): number {
  let score = 0;
  if (HISTORY_SUFFIX.test(table.name)) score += 2;
  score += Math.min(3, table.columns.filter((c) => HISTORY_COLS.has(c.name.toLowerCase())).length);
  const base = table.name.replace(HISTORY_SUFFIX, '');
  for (const r of schema.relationships) {
    if (r.kind !== 'fk' || r.fromTable !== table.id) continue;
    const target = tableById(schema, r.toTable);
    if (!target || target.id === table.id) continue;
    if (base && (target.name === base || target.name.startsWith(base) || base.startsWith(target.name))) score += 2;
    const names = new Set(target.columns.map((c) => c.name));
    const shared = table.columns.filter((c) => names.has(c.name)).length;
    if (target.columns.length > 2 && shared / target.columns.length >= 0.5) score += 1;
    break;
  }
  return score;
}

export function autoTags(project: Project, id: Id): string[] {
  const { schema, meta } = project;
  if (schema.enums.some((e) => e.id === id)) return ['enum'];
  const table = tableById(schema, id);
  if (!table) return [];
  const tags: string[] = [];
  if (meta[id]?.provenance?.kind === 'pivot' || detectPivot(schema, table)) tags.push('pivot');
  if (historyScore(schema, table) >= 3) tags.push('history');
  return tags;
}

export function effectiveTags(project: Project, id: Id): string[] {
  const m = project.meta[id];
  const suppressed = new Set(m?.suppressedTags ?? []);
  const out = new Set<string>();
  for (const t of autoTags(project, id)) if (!suppressed.has(t)) out.add(t);
  for (const t of m?.tags ?? []) out.add(t);
  return [...out];
}

export function allTags(project: Project): string[] {
  const s = new Set<string>(['pivot', 'history', 'enum']);
  for (const t of project.schema.tables) effectiveTags(project, t.id).forEach((x) => s.add(x));
  return [...s];
}

/** Pivot (tag efetiva) → os dois lados que ela liga, para desenhar a aresta N:N virtual */
export function pivotEnds(project: Project, table: Table): { a: Id; b: Id } | null {
  const p = project.meta[table.id]?.provenance;
  if (p?.kind === 'pivot') return { a: p.a, b: p.b };
  return detectPivot(project.schema, table);
}
