import * as Y from 'yjs';
import type {
  CheckConstraint,
  Column,
  EntityMeta,
  EnumType,
  Id,
  Index,
  LayoutEntry,
  NoteBlock,
  Relationship,
  Table,
  UniqueConstraint,
} from '@erd/model/types';
import { byOrder, reorder } from './order';
import type { YEntity } from './schema';

/**
 * Codificação de cada entidade num Y.Map: um campo por chave, para que edições
 * concorrentes em campos diferentes da mesma entidade sobrevivam (LWW por campo).
 * Valores pequenos e atômicos (tipo da coluna, PK, um índice) ficam como JSON e são
 * substituídos inteiros.
 */

export interface Stamp {
  by?: string;
  at?: number;
}

/* ------------------------------------------------------------------ */
/* Escrita                                                              */
/* ------------------------------------------------------------------ */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const clone = <T>(v: T): T => (v && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v);

/** Acumula se alguma escrita aconteceu (para carimbar `_by`/`_at` só no que mudou) */
class Writer {
  changed = false;
  constructor(readonly stamp: Stamp) {}

  set(y: YEntity, key: string, value: unknown) {
    if (value === undefined) {
      if (y.has(key)) {
        y.delete(key);
        this.changed = true;
      }
      return;
    }
    if (deepEqual(y.get(key), value)) return;
    y.set(key, clone(value));
    this.changed = true;
  }

  submap(y: YEntity, key: string): YEntity {
    let m = y.get(key);
    if (!(m instanceof Y.Map)) {
      m = new Y.Map();
      y.set(key, m);
      this.changed = true;
    }
    return m as YEntity;
  }

  markStamp(y: YEntity) {
    if (this.stamp.by !== undefined) y.set('_by', this.stamp.by);
    if (this.stamp.at !== undefined) y.set('_at', this.stamp.at);
  }
}

/**
 * Diff por ID de uma lista de entidades contra um Y.Map<Id, Y.Map>.
 * Sub-árvores com a mesma referência (o immer preserva o que não mudou) são puladas.
 */
export function diffEntityList<T extends { id: Id }>(
  root: Y.Map<YEntity>,
  before: readonly T[] | undefined,
  after: readonly T[],
  write: (y: YEntity, prev: T | undefined, next: T, w: Writer) => void,
  stamp: Stamp,
  ordered = true,
): boolean {
  if (before === after) return false;
  let any = false;
  const prevById = new Map((before ?? []).map((x) => [x.id, x]));
  const nextIds = new Set(after.map((x) => x.id));
  for (const id of prevById.keys()) {
    if (!nextIds.has(id) && root.has(id)) {
      root.delete(id);
      any = true;
    }
  }
  for (const item of after) {
    const prev = prevById.get(item.id);
    let y = root.get(item.id);
    if (prev === item && y instanceof Y.Map) continue;
    const w = new Writer(stamp);
    const created = !(y instanceof Y.Map);
    if (created) {
      y = new Y.Map();
      root.set(item.id, y);
      w.changed = true;
    }
    write(y as YEntity, created ? undefined : prev, item, w);
    if (w.changed) {
      w.markStamp(y as YEntity);
      any = true;
    }
  }
  if (ordered) {
    const fresh = reorder(
      after.map((x) => x.id),
      (id) => root.get(id)?.get('order'),
    );
    for (const [id, key] of fresh) {
      root.get(id)!.set('order', key);
      any = true;
    }
  }
  return any;
}

/** Lista de valores JSON pequenos (uniques, índices, checks) com ordem embutida em `_o` */
function diffJsonList<T extends { id: Id }>(root: Y.Map<unknown>, items: readonly T[], w: Writer) {
  const ids = new Set(items.map((x) => x.id));
  for (const k of [...root.keys()]) {
    if (!ids.has(k)) {
      root.delete(k);
      w.changed = true;
    }
  }
  const orders = reorder(
    items.map((x) => x.id),
    (id) => (root.get(id) as { _o?: string } | undefined)?._o,
  );
  for (const item of items) {
    const cur = root.get(item.id) as (T & { _o?: string }) | undefined;
    const _o = orders.get(item.id) ?? cur?._o;
    const { _o: _ignored, ...curItem } = cur ?? ({} as T & { _o?: string });
    if (cur && deepEqual(curItem, item) && _o === cur._o) continue;
    root.set(item.id, { ...clone(item), _o });
    w.changed = true;
  }
}

export function writeColumn(y: YEntity, _prev: Column | undefined, c: Column, w: Writer) {
  w.set(y, 'name', c.name);
  w.set(y, 'type', c.type);
  w.set(y, 'nullable', c.nullable);
  w.set(y, 'default', c.default);
  w.set(y, 'unique', c.unique);
  w.set(y, 'identity', c.identity);
  w.set(y, 'comment', c.comment);
}

export function writeTable(y: YEntity, prev: Table | undefined, t: Table, w: Writer) {
  w.set(y, 'name', t.name);
  w.set(y, 'schema', t.schema);
  w.set(y, 'comment', t.comment);
  w.set(y, 'primaryKey', t.primaryKey);
  w.set(y, 'primaryKeyName', t.primaryKeyName);
  if (diffEntityList(w.submap(y, 'columns') as Y.Map<YEntity>, prev?.columns, t.columns, writeColumn, w.stamp)) w.changed = true;
  if (!prev || prev.uniques !== t.uniques) diffJsonList(w.submap(y, 'uniques'), t.uniques, w);
  if (!prev || prev.indexes !== t.indexes) diffJsonList(w.submap(y, 'indexes'), t.indexes, w);
  if (!prev || prev.checks !== t.checks) diffJsonList(w.submap(y, 'checks'), t.checks, w);
}

/** Edição mínima de um Y.Array<string>: mantém prefixo e sufixo comuns */
function writeStringArray(arr: Y.Array<string>, next: readonly string[], w: Writer) {
  const cur = arr.toArray();
  if (deepEqual(cur, next)) return;
  let s = 0;
  while (s < cur.length && s < next.length && cur[s] === next[s]) s++;
  let ec = cur.length;
  let en = next.length;
  while (ec > s && en > s && cur[ec - 1] === next[en - 1]) {
    ec--;
    en--;
  }
  if (ec > s) arr.delete(s, ec - s);
  if (en > s) arr.insert(s, next.slice(s, en));
  w.changed = true;
}

export function writeEnum(y: YEntity, _prev: EnumType | undefined, e: EnumType, w: Writer) {
  w.set(y, 'name', e.name);
  w.set(y, 'schema', e.schema);
  let values = y.get('values');
  if (!(values instanceof Y.Array)) {
    values = new Y.Array<string>();
    y.set('values', values);
    w.changed = true;
  }
  writeStringArray(values as Y.Array<string>, e.values, w);
}

const REL_FIELDS = [
  'kind',
  'name',
  'fromTable',
  'fromColumns',
  'toTable',
  'toColumns',
  'onDelete',
  'onUpdate',
  'cardinality',
  'label',
  'showReverse',
  'reverseLabel',
  'reverseCardinality',
] as const;

export function writeRelationship(y: YEntity, _prev: Relationship | undefined, r: Relationship, w: Writer) {
  for (const k of REL_FIELDS) w.set(y, k, r[k]);
}

/** Edição mínima de texto (prefixo/sufixo comuns): preserva cursores remotos fora do trecho */
export function writeText(t: Y.Text, next: string): boolean {
  const cur = t.toString();
  if (cur === next) return false;
  let s = 0;
  while (s < cur.length && s < next.length && cur[s] === next[s]) s++;
  let ec = cur.length;
  let en = next.length;
  while (ec > s && en > s && cur[ec - 1] === next[en - 1]) {
    ec--;
    en--;
  }
  if (ec > s) t.delete(s, ec - s);
  if (en > s) t.insert(s, next.slice(s, en));
  return true;
}

export function writeNote(y: YEntity, _prev: NoteBlock | undefined, n: NoteBlock, w: Writer) {
  w.set(y, 'title', n.title);
  w.set(y, 'color', n.color);
  let content = y.get('content');
  if (!(content instanceof Y.Text)) {
    content = new Y.Text();
    y.set('content', content);
    w.changed = true;
  }
  if (writeText(content as Y.Text, n.content)) w.changed = true;
}

export function writeLayout(y: YEntity, l: LayoutEntry, w: Writer) {
  w.set(y, 'x', l.x);
  w.set(y, 'y', l.y);
  w.set(y, 'w', l.w);
  w.set(y, 'h', l.h);
  w.set(y, 'collapsed', l.collapsed);
}

export function writeMeta(y: YEntity, m: EntityMeta, w: Writer) {
  w.set(y, 'tags', m.tags);
  w.set(y, 'suppressedTags', m.suppressedTags);
  w.set(y, 'provenance', m.provenance);
  w.set(y, 'formatNames', m.formatNames);
}

/** Diff de um Record<Id, V> (layout, entityMeta) — sem ordem nem carimbo */
export function diffRecord<V>(root: Y.Map<YEntity>, before: Record<Id, V> | undefined, after: Record<Id, V>, write: (y: YEntity, v: V, w: Writer) => void): boolean {
  if (before === after) return false;
  let any = false;
  for (const id of Object.keys(before ?? {})) {
    if (!(id in after) && root.has(id)) {
      root.delete(id);
      any = true;
    }
  }
  for (const [id, v] of Object.entries(after)) {
    // igual ao de antes: nada a escrever (inclusive posições que só a projeção calculou)
    if (before && id in before && (before[id] === v || deepEqual(before[id], v))) continue;
    let y = root.get(id);
    const w = new Writer({});
    if (!(y instanceof Y.Map)) {
      y = new Y.Map();
      root.set(id, y);
    }
    write(y, v, w);
    if (w.changed) any = true;
  }
  return any;
}

/* ------------------------------------------------------------------ */
/* Leitura                                                              */
/* ------------------------------------------------------------------ */

const get = (y: YEntity, k: string) => {
  const v = y.get(k);
  return v && typeof v === 'object' && !(v instanceof Y.AbstractType) ? clone(v) : v;
};

/** Monta um objeto só com as chaves definidas, na ordem dada */
function pick(y: YEntity, base: Record<string, unknown>, keys: readonly string[]) {
  for (const k of keys) {
    const v = get(y, k);
    if (v !== undefined) base[k] = v;
  }
  return base;
}

function readOrdered<T extends { id: Id }>(m: unknown, read: (y: YEntity, id: Id) => T | undefined): T[] {
  if (!(m instanceof Y.Map)) return [];
  const items: (T & { __o?: string })[] = [];
  const orders = new Map<Id, string | undefined>();
  for (const [id, y] of (m as Y.Map<unknown>).entries()) {
    if (!(y instanceof Y.Map)) continue;
    const v = read(y as YEntity, id);
    if (!v) continue;
    const o = y.get('order');
    orders.set(id, typeof o === 'string' ? o : undefined);
    items.push(v);
  }
  return byOrder(items, (x) => orders.get(x.id));
}

function readJsonList<T extends { id: Id }>(m: unknown): T[] {
  if (!(m instanceof Y.Map)) return [];
  const items: (T & { _o?: string })[] = [];
  for (const [id, v] of (m as Y.Map<unknown>).entries()) {
    if (!v || typeof v !== 'object' || v instanceof Y.AbstractType) continue;
    items.push({ ...clone(v as T & { _o?: string }), id });
  }
  return byOrder(items, (x) => x._o).map(({ _o: _ignored, ...x }) => x as unknown as T);
}

export function readColumn(y: YEntity, id: Id): Column {
  return pick(y, { id }, ['name', 'type', 'nullable', 'default', 'unique', 'identity', 'comment']) as unknown as Column;
}

export function readTable(y: YEntity, id: Id): Table {
  const t = pick(y, { id }, ['name', 'schema']) as Record<string, unknown>;
  t.columns = readOrdered(y.get('columns'), readColumn);
  t.primaryKey = get(y, 'primaryKey') ?? [];
  const pkName = get(y, 'primaryKeyName');
  if (pkName !== undefined) t.primaryKeyName = pkName;
  t.uniques = readJsonList<UniqueConstraint>(y.get('uniques'));
  t.indexes = readJsonList<Index>(y.get('indexes'));
  t.checks = readJsonList<CheckConstraint>(y.get('checks'));
  const comment = get(y, 'comment');
  if (comment !== undefined) t.comment = comment;
  return t as unknown as Table;
}

export function readEnum(y: YEntity, id: Id): EnumType {
  const e = pick(y, { id }, ['name', 'schema']) as Record<string, unknown>;
  const values = y.get('values');
  e.values = values instanceof Y.Array ? values.toArray() : [];
  return e as unknown as EnumType;
}

export function readRelationship(y: YEntity, id: Id): Relationship {
  return pick(y, { id }, REL_FIELDS) as unknown as Relationship;
}

export function readNote(y: YEntity, id: Id): NoteBlock {
  const content = y.get('content');
  const n: Record<string, unknown> = { id, title: get(y, 'title') ?? '', content: content instanceof Y.Text ? content.toString() : '' };
  const color = get(y, 'color');
  if (color !== undefined) n.color = color;
  return n as unknown as NoteBlock;
}

export function readLayout(y: YEntity): LayoutEntry {
  return pick(y, {}, ['x', 'y', 'w', 'h', 'collapsed']) as unknown as LayoutEntry;
}

export function readMeta(y: YEntity): EntityMeta {
  return pick(y, {}, ['tags', 'suppressedTags', 'provenance', 'formatNames']) as EntityMeta;
}

export { readOrdered };
export type { Writer };
