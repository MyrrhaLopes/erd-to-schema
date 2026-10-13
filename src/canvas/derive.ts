import type { Node } from '@xyflow/react';
import type { Id, Project, Relationship } from '../model/types';
import { columnById, relCardinality, relOptional, tableById } from '../model/schema';
import { effectiveTags, pivotEnds } from '../model/tags';
import { estimateSize, TABLE_WIDTH } from '../model/project';
import type { ErdEdge, EndMark } from './edges/edges';
import type { TableFlowNode } from './nodes/TableNode';

export interface Visibility {
  hiddenTables: Set<Id>;
  visible: (id: Id) => boolean;
}

export function computeVisibility(project: Project): Visibility {
  const { view, schema } = project;
  const hidden = new Set(view.hiddenTags);
  const hiddenTables = new Set<Id>();
  for (const t of schema.tables) if (effectiveTags(project, t.id).some((x) => hidden.has(x))) hiddenTables.add(t.id);
  const enumsHidden = !view.showEnums || hidden.has('enum');
  return {
    hiddenTables,
    visible: (id) => {
      if (hiddenTables.has(id)) return false;
      if (schema.enums.some((e) => e.id === id)) return !enumsHidden;
      if (project.notes.some((n) => n.id === id)) return view.showNotes;
      return true;
    },
  };
}

export function deriveNodes(project: Project, relationSource: Id | null): Node[] {
  const { schema, layout, notes } = project;
  const vis = computeVisibility(project);
  const nodes: Node[] = [];
  const fkCols = new Map<Id, string[]>();
  for (const r of schema.relationships) if (r.kind === 'fk') fkCols.set(r.fromTable, [...(fkCols.get(r.fromTable) ?? []), ...r.fromColumns]);

  for (const t of schema.tables) {
    if (!vis.visible(t.id)) continue;
    const l = layout[t.id] ?? { x: 0, y: 0 };
    const n: TableFlowNode = {
      id: t.id,
      type: 'table',
      position: { x: l.x, y: l.y },
      data: { table: t, fkCols: fkCols.get(t.id) ?? [], tags: effectiveTags(project, t.id), relationTarget: relationSource === t.id },
      style: { width: l.w ?? TABLE_WIDTH },
    };
    nodes.push(n);
  }
  for (const e of schema.enums) {
    if (!vis.visible(e.id)) continue;
    const l = layout[e.id] ?? { x: 0, y: 0 };
    nodes.push({ id: e.id, type: 'enum', position: { x: l.x, y: l.y }, data: { enumType: e }, style: { width: l.w ?? 180 } });
  }
  for (const note of notes) {
    if (!vis.visible(note.id)) continue;
    const l = layout[note.id] ?? { x: 0, y: 0 };
    nodes.push({
      id: note.id,
      type: 'note',
      position: { x: l.x, y: l.y },
      data: { note },
      style: { width: l.w ?? 260, height: l.h ?? 180 },
      dragHandle: undefined,
    });
  }
  return nodes;
}

function centerX(project: Project, id: Id) {
  const l = project.layout[id];
  if (!l) return 0;
  return l.x + estimateSize(project.schema, id, l).w / 2;
}

/** Lado dos handles: sai pela direita se o destino está à direita */
function sides(project: Project, a: Id, b: Id): ['L' | 'R', 'L' | 'R'] {
  if (a === b) return ['R', 'R'];
  return centerX(project, a) <= centerX(project, b) ? ['R', 'L'] : ['L', 'R'];
}

function noteMarks(r: Relationship): [EndMark, EndMark] {
  switch (r.cardinality) {
    case 'N:1':
      return ['zero-many', 'one'];
    case '1:N':
      return ['one', 'zero-many'];
    case '1:1':
      return ['one', 'one'];
    case 'N:N':
      return ['zero-many', 'zero-many'];
    default:
      return ['none', 'none'];
  }
}

export function deriveEdges(project: Project): ErdEdge[] {
  const { schema, view } = project;
  const vis = computeVisibility(project);
  const edges: ErdEdge[] = [];

  for (const r of schema.relationships) {
    if (!vis.visible(r.fromTable) || !vis.visible(r.toTable)) continue;
    if (r.kind === 'note' && !view.showNoteRelations) continue;
    const from = tableById(schema, r.fromTable);
    const to = tableById(schema, r.toTable);
    if (!from || !to) continue;
    const [sa, sb] = sides(project, r.fromTable, r.toTable);
    const handle = (tableId: Id, cols: Id[], side: 'L' | 'R') => (cols.length ? `${cols[0]}-${side}` : `${tableId}-h${side}`);
    const colNames = (t: typeof from, ids: Id[]) => ids.map((c) => columnById(t, c)?.name).join(', ');
    if (r.kind === 'fk') {
      const card = relCardinality(schema, r);
      const opt = relOptional(schema, r);
      const detail = [
        `${from.name}(${colNames(from, r.fromColumns)}) → ${to.name}(${colNames(to, r.toColumns)})`,
        r.onDelete && r.onDelete !== 'no action' ? `ON DELETE ${r.onDelete.toUpperCase()}` : '',
        r.onUpdate && r.onUpdate !== 'no action' ? `ON UPDATE ${r.onUpdate.toUpperCase()}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      edges.push({
        id: r.id,
        type: 'erd',
        source: r.fromTable,
        target: r.toTable,
        sourceHandle: handle(r.fromTable, r.fromColumns, sa),
        targetHandle: handle(r.toTable, r.toColumns, sb),
        data: {
          variant: 'fk',
          start: card === '1:1' ? 'zero-one' : 'zero-many',
          end: opt ? 'zero-one' : 'one',
          label: card === '1:1' ? '1:1' : 'N:1',
          detail,
        },
      });
    } else {
      const [start, end] = noteMarks(r);
      edges.push({
        id: r.id,
        type: 'erd',
        source: r.fromTable,
        target: r.toTable,
        sourceHandle: handle(r.fromTable, r.fromColumns, sa),
        targetHandle: handle(r.toTable, r.toColumns, sb),
        data: { variant: 'note', start, end, label: r.label || 'nota', detail: 'Relação somente de nota (não gera FK)' },
      });
    }
  }

  // pivots ocultos viram uma aresta N:N virtual direta entre as duas tabelas
  for (const t of schema.tables) {
    if (!vis.hiddenTables.has(t.id) || !effectiveTags(project, t.id).includes('pivot')) continue;
    const ends = pivotEnds(project, t);
    if (!ends || !vis.visible(ends.a) || !vis.visible(ends.b)) continue;
    if (!tableById(schema, ends.a) || !tableById(schema, ends.b)) continue;
    const [sa, sb] = sides(project, ends.a, ends.b);
    edges.push({
      id: `nn:${t.id}`,
      type: 'erd',
      source: ends.a,
      target: ends.b,
      sourceHandle: `${ends.a}-h${sa}`,
      targetHandle: `${ends.b}-h${sb}`,
      data: { variant: 'nn', start: 'zero-many', end: 'zero-many', label: `N:N · ${t.name}`, detail: `Via tabela pivot ${t.name} (oculta)` },
    });
  }
  return edges;
}
