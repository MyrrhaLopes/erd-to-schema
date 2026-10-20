import * as Y from 'yjs';
import type { EntityMeta, EnumType, Id, LayoutEntry, NoteBlock, Relationship, SchemaModel, Table } from '@erd/model/types';
import { placeNewEntities } from '@erd/model/project';
import { unflattenDocContent } from '@erd/model/docContent';
import { sanitizeSchema } from '@erd/model/schema';
import { deepEqual, readEnum, readLayout, readMeta, readNote, readRelationship, readTable } from './codec';
import { byOrder } from './order';
import { MODEL_ROOTS, roots, type ModelRoot, type ProjectDoc, type YEntity } from './schema';
import { DocFieldZ, EntityMetaZ, EnumZ, LayoutZ, NoteZ, RelationshipZ, TableZ, check } from './validate';

type Dirty = Map<ModelRoot, Set<Id> | 'all'>;

interface Cache {
  tables: Map<Id, Table>;
  enums: Map<Id, EnumType>;
  relationships: Map<Id, Relationship>;
  layout: Map<Id, LayoutEntry>;
  entityMeta: Map<Id, EntityMeta>;
  notes: Map<Id, NoteBlock>;
  orders: Map<Id, string | undefined>;
}

/**
 * Projeção Y.Doc → `ProjectDoc` (§4.3). Tolerante: valida cada entidade com zod e
 * descarta referências penduradas sem escrever no documento. Incremental: depois de
 * cada transação só as entidades tocadas são relidas, e as outras mantêm a referência,
 * então o React Flow só re-renderiza os nós que mudaram.
 */
export class Projector {
  private cache: Cache = {
    tables: new Map(),
    enums: new Map(),
    relationships: new Map(),
    layout: new Map(),
    entityMeta: new Map(),
    notes: new Map(),
    orders: new Map(),
  };
  private value: ProjectDoc;
  private rootNames: Map<Y.AbstractType<unknown>, ModelRoot>;

  constructor(private readonly doc: Y.Doc) {
    const r = roots(doc);
    this.rootNames = new Map(MODEL_ROOTS.map((k) => [r[k] as Y.AbstractType<unknown>, k]));
    this.value = this.rebuild(new Map(MODEL_ROOTS.map((k) => [k, 'all' as const])));
  }

  get current(): ProjectDoc {
    return this.value;
  }

  /** Atualiza a projeção a partir de uma transação; devolve se algo do modelo mudou */
  update(tr: Y.Transaction): boolean {
    const dirty: Dirty = new Map();
    for (const [type, keys] of tr.changed) this.markDirty(dirty, type as Y.AbstractType<unknown>, keys);
    if (!dirty.size) return false;
    this.value = this.rebuild(dirty);
    return true;
  }

  /** Releitura completa (ex.: depois de carregar um update inteiro) */
  refresh(): ProjectDoc {
    this.value = this.rebuild(new Map(MODEL_ROOTS.map((k) => [k, 'all' as const])));
    return this.value;
  }

  private markDirty(dirty: Dirty, type: Y.AbstractType<unknown>, keys: Set<string | null>) {
    // sobe até o filho direto de uma raiz do modelo: esse filho é a entidade
    let t: Y.AbstractType<unknown> | null = type;
    let entityKey: string | null = null;
    while (t) {
      const root = this.rootNames.get(t);
      if (root) {
        const cur = dirty.get(root);
        if (cur === 'all') return;
        const set = cur ?? new Set<Id>();
        if (entityKey !== null) set.add(entityKey);
        else for (const k of keys) if (k !== null) set.add(k);
        if (root === 'meta' || root === 'docContent') dirty.set(root, 'all');
        else dirty.set(root, set);
        return;
      }
      const item: Y.Item | null = t._item;
      if (!item) return; // outra raiz (código, sync, clients): não é modelo
      entityKey = typeof item.parentSub === 'string' ? item.parentSub : entityKey;
      t = item.parent as Y.AbstractType<unknown> | null;
    }
  }

  private refreshEntities<T>(
    rootName: ModelRoot,
    dirty: Dirty,
    target: Map<Id, T>,
    read: (y: YEntity, id: Id) => T | undefined,
    withOrder: boolean,
  ): boolean {
    const d = dirty.get(rootName);
    if (!d) return false;
    const root = roots(this.doc)[rootName] as Y.Map<unknown>;
    const ids = d === 'all' ? new Set([...target.keys(), ...root.keys()]) : d;
    for (const id of ids) {
      const y = root.get(id);
      const v = y instanceof Y.Map ? read(y as YEntity, id) : undefined;
      if (v === undefined) {
        target.delete(id);
        if (withOrder) this.cache.orders.delete(rootName + ':' + id);
      } else {
        target.set(id, v);
        if (withOrder) {
          const o = (y as YEntity).get('order');
          this.cache.orders.set(rootName + ':' + id, typeof o === 'string' ? o : undefined);
        }
      }
    }
    return true;
  }

  private sorted<T extends { id: Id }>(rootName: ModelRoot, m: Map<Id, T>): T[] {
    return byOrder([...m.values()], (x) => this.cache.orders.get(rootName + ':' + x.id));
  }

  private rebuild(dirty: Dirty): ProjectDoc {
    const c = this.cache;
    const prev = this.value as ProjectDoc | undefined;
    const tablesChanged = this.refreshEntities('tables', dirty, c.tables, (y, id) => check(TableZ, readTable(y, id), `tabela ${id}`), true);
    const enumsChanged = this.refreshEntities('enums', dirty, c.enums, (y, id) => check(EnumZ, readEnum(y, id), `enum ${id}`), true);
    const relsChanged = this.refreshEntities('relationships', dirty, c.relationships, (y, id) => check(RelationshipZ, readRelationship(y, id), `relação ${id}`), true);
    const layoutChanged = this.refreshEntities('layout', dirty, c.layout, (y, id) => check(LayoutZ, readLayout(y), `layout ${id}`), false);
    const metaChanged = this.refreshEntities('entityMeta', dirty, c.entityMeta, (y, id) => check(EntityMetaZ, readMeta(y), `meta ${id}`), false);
    const notesChanged = this.refreshEntities('notes', dirty, c.notes, (y, id) => check(NoteZ, readNote(y, id), `nota ${id}`), true);

    let schema: SchemaModel;
    if (!prev || tablesChanged || enumsChanged || relsChanged) {
      schema = {
        tables: !prev || tablesChanged ? this.sorted('tables', c.tables) : prev.schema.tables,
        enums: !prev || enumsChanged ? this.sorted('enums', c.enums) : prev.schema.enums,
        relationships: this.sorted('relationships', c.relationships),
      };
      // referências penduradas (FK para coluna que sumiu num merge concorrente) são ignoradas
      sanitizeSchema(schema);
      if (prev && sameArray(schema.relationships, prev.schema.relationships)) schema.relationships = prev.schema.relationships;
    } else schema = prev.schema;

    let layout = prev && !layoutChanged && schema === prev.schema && !notesChanged ? prev.layout : Object.fromEntries(c.layout);
    const notes = !prev || notesChanged ? this.sorted('notes', c.notes) : prev.notes;
    // entidades sem posição (ex.: criadas pelo bot de outro cliente) ganham uma posição
    // determinística só na projeção — nada é escrito no documento
    const missing = [...schema.tables, ...schema.enums].some((e) => !layout[e.id]);
    if (missing) {
      layout = { ...layout };
      placeNewEntities({ schema, layout, notes });
    }
    if (prev && layout !== prev.layout) {
      for (const k of Object.keys(layout)) if (prev.layout[k] && layout[k] !== prev.layout[k] && deepEqual(layout[k], prev.layout[k])) layout[k] = prev.layout[k];
      if (sameRecord(layout, prev.layout)) layout = prev.layout;
    }

    const meta = prev && !metaChanged ? prev.meta : Object.fromEntries(c.entityMeta);
    const nameRaw = roots(this.doc).meta.get('name');
    const name = typeof nameRaw === 'string' ? nameRaw : 'Projeto';
    let content = prev?.doc;
    if (!prev || dirty.has('docContent')) {
      content = readDocContent(this.doc);
      if (prev?.doc && content && deepEqual(content, prev.doc)) content = prev.doc;
    }
    if (prev && prev.name === name && prev.schema === schema && prev.layout === layout && prev.meta === meta && prev.notes === notes && prev.doc === content) return prev;
    const out: ProjectDoc = { name, schema, layout, meta, notes };
    if (content) out.doc = content;
    return out;
  }
}

/** Formulário do documento (raiz `doc`), ou `undefined` quando ninguém preencheu nada */
export function readDocContent(doc: Y.Doc) {
  const root = roots(doc).docContent;
  if (!root.size) return undefined;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of root.entries()) if (DocFieldZ.safeParse({ key: k, value: v }).success) flat[k] = v;
  return unflattenDocContent(flat);
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameRecord<T>(a: Record<string, T>, b: Record<string, T>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Projeção pontual (sem cache), para o servidor e testes */
export function projectDoc(doc: Y.Doc): ProjectDoc {
  return new Projector(doc).current;
}

/**
 * Entidades do documento que não passam na validação (o servidor recusa um import ou
 * update que produza lixo, em vez de aceitar e deixar a projeção pulá-las em silêncio).
 */
export function invalidEntities(doc: Y.Doc): string[] {
  const r = roots(doc);
  const bad: string[] = [];
  const scan = (name: ModelRoot, read: (y: YEntity, id: Id) => unknown) => {
    for (const [id, y] of (r[name] as Y.Map<unknown>).entries()) {
      if (!(y instanceof Y.Map) || read(y as YEntity, id) === undefined) bad.push(`${name}:${id}`);
    }
  };
  const quiet = <T>(z: Parameters<typeof check<T>>[0], v: unknown): T | undefined => (z.safeParse(v).success ? (v as T) : undefined);
  scan('tables', (y, id) => quiet(TableZ, readTable(y, id)));
  scan('enums', (y, id) => quiet(EnumZ, readEnum(y, id)));
  scan('relationships', (y, id) => quiet(RelationshipZ, readRelationship(y, id)));
  scan('layout', (y) => quiet(LayoutZ, readLayout(y)));
  scan('entityMeta', (y) => quiet(EntityMetaZ, readMeta(y)));
  scan('notes', (y, id) => quiet(NoteZ, readNote(y, id)));
  for (const [k, v] of r.docContent.entries()) if (!DocFieldZ.safeParse({ key: k, value: v }).success) bad.push(`doc:${k}`);
  return bad;
}
