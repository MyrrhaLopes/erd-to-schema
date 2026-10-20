import type { EnumType, Id, LayoutEntry, Project, SchemaModel, ViewState } from './types';
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

function range(a: number, b: number): number[] {
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) out.push(i);
  else for (let i = a; i >= b; i--) out.push(i);
  return out;
}

/** Posição Y média das tabelas cuja coluna referencia este enum — usada só para ordenar a coluna de enums */
function avgRefY(schema: SchemaModel, layout: Record<Id, LayoutEntry>, e: EnumType): number {
  const ys: number[] = [];
  for (const t of schema.tables) for (const c of t.columns) if (c.type.base === e.name) ys.push(layout[t.id]?.y ?? 0);
  return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : Infinity;
}

/**
 * Layout em camadas (nível = caminho mais longo via FK, "mãe" à esquerda) com a ordem
 * dentro de cada camada otimizada por baricentro — a heurística clássica de redução de
 * cruzamentos do método de Sugiyama: poucas idas-e-voltas entre camadas vizinhas já
 * aproximam bastante do mínimo de cruzamentos. Relações-nota também entram na ordenação
 * (não só FKs), para que tabelas ligadas por nota fiquem próximas na mesma camada.
 * O lado (L/R/T/B) de cada ponta de relação não é guardado aqui: `canvas/derive.ts` o
 * recalcula a partir da posição final, sempre apontando geometricamente para o outro nó.
 */
export function autoLayout(project: Pick<Project, 'schema' | 'layout' | 'notes'>) {
  const { schema, layout } = project;
  const tableIds = new Set(schema.tables.map((t) => t.id));

  const level = new Map<Id, number>();
  const fkParents = new Map<Id, Id[]>();
  for (const r of schema.relationships) {
    if (r.kind !== 'fk' || r.fromTable === r.toTable) continue;
    fkParents.set(r.fromTable, [...(fkParents.get(r.fromTable) ?? []), r.toTable]);
  }
  const visitLevel = (id: Id, stack: Set<Id>): number => {
    if (level.has(id)) return level.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const ps = fkParents.get(id) ?? [];
    const l = ps.length ? Math.max(...ps.map((p) => visitLevel(p, stack) + 1)) : 0;
    stack.delete(id);
    level.set(id, l);
    return l;
  };
  schema.tables.forEach((t) => visitLevel(t.id, new Set()));

  // vizinhos não-direcionais (FK + nota) só para ordenar dentro da camada, nunca para o nível
  const neighbors = new Map<Id, Id[]>();
  for (const r of schema.relationships) {
    if (r.fromTable === r.toTable || !tableIds.has(r.fromTable) || !tableIds.has(r.toTable)) continue;
    neighbors.set(r.fromTable, [...(neighbors.get(r.fromTable) ?? []), r.toTable]);
    neighbors.set(r.toTable, [...(neighbors.get(r.toTable) ?? []), r.fromTable]);
  }

  const order = new Map<number, Id[]>();
  for (const t of schema.tables) {
    const l = level.get(t.id) ?? 0;
    order.set(l, [...(order.get(l) ?? []), t.id]);
  }
  const maxLevel = Math.max(0, ...order.keys());

  const posInLevel = new Map<Id, number>();
  const rebuildPos = () => {
    for (const ids of order.values()) ids.forEach((id, i) => posInLevel.set(id, i));
  };
  rebuildPos();

  const SWEEPS = 6;
  for (let iter = 0; iter < SWEEPS; iter++) {
    const forward = iter % 2 === 0;
    for (const lvl of forward ? range(0, maxLevel) : range(maxLevel, 0)) {
      const refLevel = forward ? lvl - 1 : lvl + 1;
      const ids = order.get(lvl);
      if (refLevel < 0 || refLevel > maxLevel || !ids || ids.length < 2) continue;
      const bary = new Map<Id, number>();
      for (const id of ids) {
        const refs = (neighbors.get(id) ?? []).filter((n) => level.get(n) === refLevel);
        bary.set(id, refs.length ? refs.reduce((s, n) => s + (posInLevel.get(n) ?? 0), 0) / refs.length : posInLevel.get(id)!);
      }
      ids.sort((a, b) => bary.get(a)! - bary.get(b)!);
      rebuildPos();
    }
  }

  for (const [l, ids] of order) {
    let y = 0;
    for (const id of ids) {
      layout[id] = { ...layout[id], x: l * (TABLE_WIDTH + 140), y };
      y += estimateSize(schema, id).h + 50;
    }
  }

  let y = 0;
  const ex = (maxLevel + 1) * (TABLE_WIDTH + 140);
  for (const e of [...schema.enums].sort((a, b) => avgRefY(schema, layout, a) - avgRefY(schema, layout, b))) {
    layout[e.id] = { ...layout[e.id], x: ex, y };
    y += estimateSize(schema, e.id).h + 40;
  }
}
