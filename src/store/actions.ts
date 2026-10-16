import type { Draft } from 'immer';
import type { Column, Id, NoteBlock, Relationship, Table } from '../model/types';
import { fkTypeFor } from '../model/columnType';
import { newId, singularize, snakeCase, uniqueName } from '../model/naming';
import { estimateSize, findFreeSpot, NOTE_H, NOTE_W, TABLE_WIDTH } from '../model/project';
import { columnById, removeColumnCascade, removeTableCascade, tableById } from '../model/schema';
import { useProjectStore, type Doc } from './useProjectStore';

const commit = (recipe: (d: Draft<Doc>) => void, changes?: string[]) => useProjectStore.getState().commit(recipe, 'canvas', changes);

const doc = () => useProjectStore.getState().doc;

export function newTable(d: Draft<Doc> | Doc, name: string, pos: { x: number; y: number }, opts: { withId?: boolean } = {}): Table {
  const id = newId('t_');
  const pk: Column = { id: newId('c_'), name: 'id', type: { base: 'serial' }, nullable: false };
  const t: Table = {
    id,
    name: uniqueName(name, d.schema.tables.map((x) => x.name)),
    columns: opts.withId === false ? [] : [pk],
    primaryKey: opts.withId === false ? [] : [pk.id],
    uniques: [],
    indexes: [],
    checks: [],
  };
  d.schema.tables.push(t);
  d.layout[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  return t;
}

export function createTable(pos: { x: number; y: number }): Id {
  let id = '';
  commit((d) => {
    id = newTable(d, 'nova_tabela', pos).id;
  }, ['Tabela criada']);
  return id;
}

export function createNote(pos: { x: number; y: number }): Id {
  const id = newId('n_');
  commit((d) => {
    const note: NoteBlock = { id, title: 'Nota', content: 'Escreva em **Markdown**…' };
    d.notes.push(note);
    d.layout[id] = { x: Math.round(pos.x), y: Math.round(pos.y), w: NOTE_W, h: NOTE_H };
  }, ['Nota criada']);
  return id;
}

/** Adiciona à tabela `from` colunas FK apontando para a PK de `to` */
function addFkColumns(from: Draft<Table>, to: Draft<Table>, nullable = false): Id[] {
  const pkCols = to.primaryKey.map((c) => columnById(to as Table, c)!).filter(Boolean);
  if (!pkCols.length) {
    const pk: Column = { id: newId('c_'), name: 'id', type: { base: 'serial' }, nullable: false };
    to.columns.unshift(pk);
    to.primaryKey = [pk.id];
    pkCols.push(pk);
  }
  const base = singularize(to.name);
  const ids: Id[] = [];
  for (const pk of pkCols) {
    const name = uniqueName(`${snakeCase(base)}_${pk.name}`, from.columns.map((c) => c.name));
    const col: Column = { id: newId('c_'), name, type: fkTypeFor(pk.type), nullable };
    from.columns.push(col);
    ids.push(col.id);
  }
  return ids;
}

export interface ConnectResult {
  kind: 'edge' | 'node';
  id: Id;
}

export function connectTables(fromId: Id, toId: Id, mode: 'fk' | 'note' | 'nn', cols?: { from?: Id; to?: Id }): ConnectResult | undefined {
  if (mode === 'nn') {
    const id = createPivot(fromId, toId);
    return id ? { kind: 'node', id } : undefined;
  }
  let relId = '';
  commit(
    (d) => {
      const from = d.schema.tables.find((t) => t.id === fromId);
      const to = d.schema.tables.find((t) => t.id === toId);
      if (!from || !to) return;
      if (mode === 'note') {
        relId = newId('r_');
        d.schema.relationships.push({
          id: relId,
          kind: 'note',
          fromTable: fromId,
          fromColumns: cols?.from ? [cols.from] : [],
          toTable: toId,
          toColumns: cols?.to ? [cols.to] : [],
          label: 'relação',
        });
        return;
      }
      let fromCols: Id[];
      let toCols: Id[];
      if (cols?.from && cols?.to) {
        const fc = columnById(from as Table, cols.from)!;
        const tc = columnById(to as Table, cols.to)!;
        if (fc.type.base !== fkTypeFor(tc.type).base) fc.type = fkTypeFor(tc.type);
        fromCols = [cols.from];
        toCols = [cols.to];
      } else {
        fromCols = addFkColumns(from, to);
        toCols = [...to.primaryKey];
      }
      relId = newId('r_');
      d.schema.relationships.push({
        id: relId,
        kind: 'fk',
        fromTable: fromId,
        fromColumns: fromCols,
        toTable: toId,
        toColumns: toCols,
        onDelete: 'no action',
        onUpdate: 'no action',
      });
    },
    [mode === 'fk' ? 'Relação FK criada' : 'Relação-nota criada'],
  );
  return relId ? { kind: 'edge', id: relId } : undefined;
}

/** N:N sempre materializa uma tabela pivot real com PK composta */
export function createPivot(aId: Id, bId: Id): Id | undefined {
  let pivotId: Id | undefined;
  commit((d) => {
    const a = d.schema.tables.find((t) => t.id === aId);
    const b = d.schema.tables.find((t) => t.id === bId);
    if (!a || !b) return;
    const la = d.layout[aId];
    const lb = d.layout[bId];
    const pos = la && lb ? { x: (la.x + lb.x) / 2, y: Math.max(la.y, lb.y) + 220 } : { x: 0, y: 0 };
    const pivot = newTable(d, `${singularize(a.name)}_${b.name}`, pos, { withId: false });
    const p = d.schema.tables.find((t) => t.id === pivot.id)!;
    const ca = addFkColumns(p, a);
    const cb = addFkColumns(p, b);
    p.primaryKey = [...ca, ...cb];
    d.schema.relationships.push(
      { id: newId('r_'), kind: 'fk', fromTable: p.id, fromColumns: ca, toTable: aId, toColumns: [...a.primaryKey], onDelete: 'cascade', onUpdate: 'no action' },
      { id: newId('r_'), kind: 'fk', fromTable: p.id, fromColumns: cb, toTable: bId, toColumns: [...b.primaryKey], onDelete: 'cascade', onUpdate: 'no action' },
    );
    d.meta[p.id] = { ...(d.meta[p.id] ?? {}), provenance: { kind: 'pivot', a: aId, b: bId } };
    d.layout[p.id] = findFreeSpot(d as Doc, p.id, pos);
    pivotId = p.id;
  }, ['Tabela pivot N:N criada']);
  return pivotId;
}

/** Converte uma relação-nota em tabela pivot real com PK composta */
export function convertNoteToPivot(relId: Id) {
  commit((d) => {
    const rel = d.schema.relationships.find((x) => x.id === relId);
    if (!rel || rel.kind !== 'note') return;
    const aId = rel.fromTable;
    const bId = rel.toTable;
    const a = d.schema.tables.find((t) => t.id === aId);
    const b = d.schema.tables.find((t) => t.id === bId);
    if (!a || !b) return;

    d.schema.relationships = d.schema.relationships.filter((x) => x.id !== relId);

    const la = d.layout[aId];
    const lb = d.layout[bId];
    const pos = la && lb ? { x: (la.x + lb.x) / 2, y: Math.max(la.y, lb.y) + 220 } : { x: 0, y: 0 };
    const pivot = newTable(d, `${singularize(a.name)}_${b.name}`, pos, { withId: false });
    const p = d.schema.tables.find((t) => t.id === pivot.id)!;
    const ca = addFkColumns(p, a);
    const cb = addFkColumns(p, b);
    p.primaryKey = [...ca, ...cb];
    d.schema.relationships.push(
      { id: newId('r_'), kind: 'fk', fromTable: p.id, fromColumns: ca, toTable: aId, toColumns: [...a.primaryKey], onDelete: 'cascade', onUpdate: 'no action' },
      { id: newId('r_'), kind: 'fk', fromTable: p.id, fromColumns: cb, toTable: bId, toColumns: [...b.primaryKey], onDelete: 'cascade', onUpdate: 'no action' },
    );
    d.meta[p.id] = { ...(d.meta[p.id] ?? {}), provenance: { kind: 'pivot', a: aId, b: bId } };
    d.layout[p.id] = findFreeSpot(d as Doc, p.id, pos);
  }, ['Relação-nota convertida em tabela pivot N:N']);
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Ctrl+Seta: nova tabela deslocada na direção, com FK (ou relação-nota) para a selecionada */
export function createRelatedTable(fromId: Id, dir: Direction, kind: 'fk' | 'note'): Id | null {
  const t = tableById(doc().schema, fromId);
  const l = doc().layout[fromId];
  if (!t || !l) return null;
  const size = estimateSize(doc().schema, fromId, l);
  const gap = 120;
  const pos = {
    right: { x: l.x + size.w + gap, y: l.y },
    left: { x: l.x - TABLE_WIDTH - gap, y: l.y },
    down: { x: l.x, y: l.y + size.h + gap },
    up: { x: l.x, y: l.y - 160 - gap },
  }[dir];
  let id: Id = '';
  commit(
    (d) => {
      const child = newTable(d, `${singularize(t.name)}_child`, pos);
      id = child.id;
      const parent = d.schema.tables.find((x) => x.id === fromId)!;
      const c = d.schema.tables.find((x) => x.id === id)!;
      if (kind === 'fk') {
        const cols = addFkColumns(c, parent);
        d.schema.relationships.push({
          id: newId('r_'),
          kind: 'fk',
          fromTable: id,
          fromColumns: cols,
          toTable: fromId,
          toColumns: [...parent.primaryKey],
          onDelete: 'no action',
          onUpdate: 'no action',
        });
      } else {
        d.schema.relationships.push({ id: newId('r_'), kind: 'note', fromTable: id, fromColumns: [], toTable: fromId, toColumns: [], label: 'relação' });
      }
      d.layout[id] = findFreeSpot(d as Doc, id, pos);
    },
    [kind === 'fk' ? 'Tabela criada com FK' : 'Tabela criada com relação-nota'],
  );
  return id;
}

export interface SelectionIds {
  nodes: Id[];
  edges: Id[];
}

/** Delete com cascata: tabela → relações e pivots; aresta N:N virtual → pivot */
export function deleteElements(sel: SelectionIds) {
  if (!sel.nodes.length && !sel.edges.length) return;
  commit(
      (d) => {
        for (const e of sel.edges) {
          if (e.startsWith('nn:')) {
            const pivotId = e.slice(3);
            removeTableCascade(d as never, pivotId);
          } else d.schema.relationships = d.schema.relationships.filter((r) => r.id !== e);
        }
        for (const id of sel.nodes) {
          if (d.schema.tables.some((t) => t.id === id)) removeTableCascade(d as never, id);
          else if (d.schema.enums.some((x) => x.id === id)) {
            d.schema.enums = d.schema.enums.filter((x) => x.id !== id);
            delete d.layout[id];
          } else if (d.notes.some((n) => n.id === id)) {
            d.notes = d.notes.filter((n) => n.id !== id);
            delete d.layout[id];
            delete d.meta[id];
          }
        }
      },
      [`${sel.nodes.length + sel.edges.length} elemento(s) removido(s)`],
  );
}

export function duplicateTables(ids: Id[]): Id[] {
  const out: Id[] = [];
  commit((d) => {
    for (const id of ids) {
      const t = d.schema.tables.find((x) => x.id === id);
      const l = d.layout[id];
      if (!t || !l) continue;
      const map = new Map<Id, Id>();
      const copy: Table = {
        ...structuredClone(t as Table),
        id: newId('t_'),
        name: uniqueName(t.name + '_copy', d.schema.tables.map((x) => x.name)),
      };
      copy.columns = copy.columns.map((c) => {
        const nid = newId('c_');
        map.set(c.id, nid);
        return { ...c, id: nid };
      });
      const m = (xs: Id[]) => xs.map((x) => map.get(x) ?? x);
      copy.primaryKey = m(copy.primaryKey);
      copy.uniques = copy.uniques.map((u) => ({ ...u, id: newId('u_'), name: undefined, columns: m(u.columns) }));
      copy.indexes = copy.indexes.map((i) => ({ ...i, id: newId('i_'), name: undefined, columns: m(i.columns) }));
      copy.checks = copy.checks.map((k) => ({ ...k, id: newId('k_'), name: undefined }));
      copy.primaryKeyName = undefined;
      d.schema.tables.push(copy);
      const rels: Relationship[] = d.schema.relationships
        .filter((r) => r.fromTable === id && r.kind === 'fk')
        .map((r) => ({ ...(r as Relationship), id: newId('r_'), name: undefined, fromTable: copy.id, fromColumns: m(r.fromColumns) }));
      d.schema.relationships.push(...rels);
      d.layout[copy.id] = findFreeSpot(d as Doc, copy.id, { x: l.x + 40, y: l.y + 40 });
      out.push(copy.id);
    }
  }, ['Tabela(s) duplicada(s)']);
  return out;
}

export function updateTable(id: Id, recipe: (t: Draft<Table>, d: Draft<Doc>) => void, change?: string) {
  commit((d) => {
    const t = d.schema.tables.find((x) => x.id === id);
    if (t) recipe(t, d);
  }, change ? [change] : undefined);
}

export function addColumn(tableId: Id): Id {
  const id = newId('c_');
  updateTable(tableId, (t) => {
    t.columns.push({ id, name: uniqueName('coluna', t.columns.map((c) => c.name)), type: { base: 'text' }, nullable: true });
  });
  return id;
}

export function removeColumn(tableId: Id, colId: Id) {
  commit((d) => removeColumnCascade(d.schema as never, tableId, colId));
}

export function moveColumn(tableId: Id, colId: Id, delta: number) {
  updateTable(tableId, (t) => {
    const i = t.columns.findIndex((c) => c.id === colId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= t.columns.length) return;
    const [c] = t.columns.splice(i, 1);
    t.columns.splice(j, 0, c);
  });
}

export function updateRelationship(id: Id, recipe: (r: Draft<Relationship>) => void) {
  commit((d) => {
    const r = d.schema.relationships.find((x) => x.id === id);
    if (r) recipe(r);
  });
}

export function updateNote(id: Id, recipe: (n: Draft<NoteBlock>) => void) {
  commit((d) => {
    const n = d.notes.find((x) => x.id === id);
    if (n) recipe(n);
  });
}

export function setTags(id: Id, tags: string[], suppressed: string[]) {
  commit((d) => {
    const m = (d.meta[id] ??= {});
    m.tags = tags.length ? tags : undefined;
    m.suppressedTags = suppressed.length ? suppressed : undefined;
    if (!m.tags) delete m.tags;
    if (!m.suppressedTags) delete m.suppressedTags;
  });
}

export function moveNodes(positions: { id: Id; x: number; y: number }[]) {
  if (!positions.length) return;
  commit((d) => {
    for (const p of positions) {
      const l = d.layout[p.id];
      if (l) {
        l.x = Math.round(p.x);
        l.y = Math.round(p.y);
      } else d.layout[p.id] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
  });
}

export function resizeNode(id: Id, w: number, h?: number) {
  commit((d) => {
    const l = d.layout[id];
    if (!l) return;
    l.w = Math.round(w);
    if (h !== undefined) l.h = Math.round(h);
  });
}

export function addEnum(pos: { x: number; y: number }) {
  commit((d) => {
    const id = newId('e_');
    d.schema.enums.push({ id, name: uniqueName('status', d.schema.enums.map((e) => e.name)), values: ['ativo', 'inativo'] });
    d.layout[id] = { x: pos.x, y: pos.y };
  }, ['Enum criado']);
}
