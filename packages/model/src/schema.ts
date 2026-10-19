import type { Cardinality, Column, Id, Project, Relationship, SchemaModel, Table } from './types';

export const emptySchema = (): SchemaModel => ({ tables: [], enums: [], relationships: [] });

export function tableById(schema: SchemaModel, id: Id): Table | undefined {
  return schema.tables.find((t) => t.id === id);
}

export function columnById(table: Table | undefined, id: Id): Column | undefined {
  return table?.columns.find((c) => c.id === id);
}

export function tableKey(t: { name: string; schema?: string }) {
  return `${t.schema ?? 'public'}.${t.name}`;
}

export function isColumnPk(table: Table, colId: Id) {
  return table.primaryKey.includes(colId);
}

/** Conjunto de colunas é coberto por PK/UNIQUE exatamente igual (é único)? */
export function isUniqueSet(table: Table, cols: Id[]): boolean {
  if (cols.length === 0) return false;
  const same = (a: Id[]) => a.length === cols.length && a.every((c) => cols.includes(c));
  if (same(table.primaryKey)) return true;
  if (cols.length === 1 && table.columns.find((c) => c.id === cols[0])?.unique) return true;
  if (table.uniques.some((u) => same(u.columns))) return true;
  if (table.indexes.some((i) => i.unique && !i.where && same(i.columns))) return true;
  return false;
}

/** Cardinalidade efetiva lida de `from` para `to` */
export function relCardinality(schema: SchemaModel, rel: Relationship): Cardinality {
  if (rel.kind === 'note') return rel.cardinality ?? 'N:1';
  const from = tableById(schema, rel.fromTable);
  if (from && isUniqueSet(from, rel.fromColumns)) return '1:1';
  return 'N:1';
}

/** FK é opcional (alguma coluna origem nullable)? */
export function relOptional(schema: SchemaModel, rel: Relationship): boolean {
  const from = tableById(schema, rel.fromTable);
  if (!from) return false;
  return rel.fromColumns.some((c) => columnById(from, c)?.nullable);
}

export function relationshipsOf(schema: SchemaModel, tableId: Id) {
  return schema.relationships.filter((r) => r.fromTable === tableId || r.toTable === tableId);
}

export function fkColumnIds(schema: SchemaModel, tableId: Id): Set<Id> {
  const s = new Set<Id>();
  for (const r of schema.relationships) if (r.kind === 'fk' && r.fromTable === tableId) r.fromColumns.forEach((c) => s.add(c));
  return s;
}

/** Remove de um schema (mutável — usar dentro de produce) uma tabela e tudo que depende dela */
export function removeTableCascade(project: Project, tableId: Id) {
  const schema = project.schema;
  const pivots = schema.tables.filter((t) => {
    const p = project.meta[t.id]?.provenance;
    return p?.kind === 'pivot' && (p.a === tableId || p.b === tableId) && t.id !== tableId;
  });
  schema.tables = schema.tables.filter((t) => t.id !== tableId);
  schema.relationships = schema.relationships.filter((r) => r.fromTable !== tableId && r.toTable !== tableId);
  delete project.layout[tableId];
  delete project.meta[tableId];
  for (const p of pivots) {
    const fkCols = fkColumnIds(schema, p.id);
    const businessCols = p.columns.filter((c) => !fkCols.has(c.id));
    // pivot que só liga as duas tabelas deixa de fazer sentido
    if (businessCols.length <= 1) removeTableCascade(project, p.id);
  }
}

export function removeColumnCascade(schema: SchemaModel, tableId: Id, colId: Id) {
  const t = tableById(schema, tableId);
  if (!t) return;
  t.columns = t.columns.filter((c) => c.id !== colId);
  t.primaryKey = t.primaryKey.filter((c) => c !== colId);
  t.uniques = t.uniques.map((u) => ({ ...u, columns: u.columns.filter((c) => c !== colId) })).filter((u) => u.columns.length);
  t.indexes = t.indexes.map((i) => ({ ...i, columns: i.columns.filter((c) => c !== colId) })).filter((i) => i.columns.length);
  schema.relationships = schema.relationships.filter(
    (r) =>
      !(r.fromTable === tableId && r.fromColumns.includes(colId)) && !(r.toTable === tableId && r.toColumns.includes(colId)),
  );
}

/** Remove referências penduradas (colunas/tabelas que não existem mais) */
export function sanitizeSchema(schema: SchemaModel) {
  const tables = new Map(schema.tables.map((t) => [t.id, t]));
  schema.relationships = schema.relationships.filter((r) => {
    const a = tables.get(r.fromTable);
    const b = tables.get(r.toTable);
    if (!a || !b) return false;
    if (!r.fromColumns.every((c) => a.columns.some((x) => x.id === c))) return false;
    if (!r.toColumns.every((c) => b.columns.some((x) => x.id === c))) return false;
    if (r.kind === 'fk' && (r.fromColumns.length === 0 || r.fromColumns.length !== r.toColumns.length)) return false;
    return true;
  });
}
