import type { Id, LayoutEntry, Project, SchemaModel, ViewState } from './types';
import { emptySchema } from './schema';

export const TABLE_WIDTH = 260;
export const HEADER_H = 40;
export const ROW_H = 26;
export const NOTE_W = 260;
export const NOTE_H = 180;

export const defaultView = (): ViewState => ({
  hiddenTags: [],
  showNoteRelations: true,
  showNotes: true,
  showEnums: true,
  cardinalityStyle: 'look-across',
});

export const emptyProject = (name = 'Novo projeto'): Project => ({
  version: 1,
  name,
  schema: emptySchema(),
  layout: {},
  meta: {},
  notes: [],
  view: defaultView(),
});

export function estimateSize(schema: SchemaModel, id: Id, layout?: LayoutEntry): { w: number; h: number } {
  const t = schema.tables.find((x) => x.id === id);
  if (t) return { w: layout?.w ?? TABLE_WIDTH, h: HEADER_H + Math.max(1, t.columns.length) * ROW_H + 8 };
  const e = schema.enums.find((x) => x.id === id);
  if (e) return { w: layout?.w ?? 180, h: HEADER_H + Math.max(1, e.values.length) * 22 + 8 };
  return { w: layout?.w ?? NOTE_W, h: layout?.h ?? NOTE_H };
}

/** Posiciona entidades que ainda não têm layout, sem tocar nas que já têm */
export function placeNewEntities(project: Pick<Project, 'schema' | 'layout' | 'notes'>, near?: { x: number; y: number }) {
  const { schema, layout } = project;
  const ids = [...schema.tables.map((t) => t.id), ...schema.enums.map((e) => e.id)];
  const missing = ids.filter((id) => !layout[id]);
  if (!missing.length) return;
  const placed = Object.entries(layout);
  if (!placed.length) {
    autoLayout(project);
    return;
  }
  // tenta posicionar perto da tabela relacionada já posicionada; senão, numa coluna à direita
  let maxX = -Infinity;
  let minY = Infinity;
  for (const [id, l] of placed) {
    const s = estimateSize(schema, id, l);
    maxX = Math.max(maxX, l.x + s.w);
    minY = Math.min(minY, l.y);
  }
  let x = near?.x ?? maxX + 80;
  let y = near?.y ?? minY;
  for (const id of missing) {
    const rel = schema.relationships.find((r) => (r.fromTable === id && layout[r.toTable]) || (r.toTable === id && layout[r.fromTable]));
    const anchor = rel ? layout[rel.fromTable === id ? rel.toTable : rel.fromTable] : undefined;
    let pos = anchor ? { x: anchor.x + TABLE_WIDTH + 100, y: anchor.y } : { x, y };
    pos = findFreeSpot(project, id, pos);
    layout[id] = pos;
    if (!anchor) y += estimateSize(schema, id).h + 40;
    if (y > minY + 1400) {
      y = minY;
      x += TABLE_WIDTH + 80;
    }
  }
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w + 20 && a.x + a.w + 20 > b.x && a.y < b.y + b.h + 20 && a.y + a.h + 20 > b.y;
}

export function findFreeSpot(project: Pick<Project, 'schema' | 'layout' | 'notes'>, id: Id, pos: { x: number; y: number }) {
  const size = estimateSize(project.schema, id);
  const boxes = Object.entries(project.layout)
    .filter(([k]) => k !== id)
    .map(([k, l]) => ({ x: l.x, y: l.y, ...estimateSize(project.schema, k, l) }));
  let p = { ...pos };
  for (let i = 0; i < 60; i++) {
    const hit = boxes.find((b) => overlaps({ ...p, ...size }, b));
    if (!hit) return p;
    p = { x: p.x, y: hit.y + hit.h + 30 };
  }
  return p;
}

/** Layout em camadas: tabelas "mãe" à esquerda, filhas à direita */
export function autoLayout(project: Pick<Project, 'schema' | 'layout' | 'notes'>) {
  const { schema, layout } = project;
  const level = new Map<Id, number>();
  const parents = new Map<Id, Id[]>();
  for (const r of schema.relationships) {
    if (r.kind !== 'fk' || r.fromTable === r.toTable) continue;
    parents.set(r.fromTable, [...(parents.get(r.fromTable) ?? []), r.toTable]);
  }
  const visit = (id: Id, stack: Set<Id>): number => {
    if (level.has(id)) return level.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const ps = parents.get(id) ?? [];
    const l = ps.length ? Math.max(...ps.map((p) => visit(p, stack) + 1)) : 0;
    stack.delete(id);
    level.set(id, l);
    return l;
  };
  schema.tables.forEach((t) => visit(t.id, new Set()));
  const columns = new Map<number, Id[]>();
  for (const t of schema.tables) {
    const l = level.get(t.id) ?? 0;
    columns.set(l, [...(columns.get(l) ?? []), t.id]);
  }
  const maxLevel = Math.max(0, ...columns.keys());
  for (const [l, ids] of columns) {
    let y = 0;
    for (const id of ids) {
      layout[id] = { ...layout[id], x: l * (TABLE_WIDTH + 140), y };
      y += estimateSize(schema, id).h + 50;
    }
  }
  let y = 0;
  const ex = (maxLevel + 1) * (TABLE_WIDTH + 140);
  for (const e of schema.enums) {
    layout[e.id] = { ...layout[e.id], x: ex, y };
    y += estimateSize(schema, e.id).h + 40;
  }
}
