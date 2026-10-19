import * as Y from 'yjs';
import { emptySchema } from '@erd/model/schema';
import {
  diffEntityList,
  diffRecord,
  writeEnum,
  writeLayout,
  writeMeta,
  writeNote,
  writeRelationship,
  writeTable,
  type Stamp,
} from './codec';
import { MODEL_VERSION, roots, type ProjectDoc } from './schema';

export const emptyProjectDoc = (name = 'Novo projeto'): ProjectDoc => ({ name, schema: emptySchema(), layout: {}, meta: {}, notes: [] });

/**
 * Compara `before` e `after` por ID e emite só as operações mínimas no Y.Doc (§4.3):
 * `set` nos campos que mudaram, `delete` no que sumiu, Y.Map novos no que nasceu e
 * chave de ordem nova só no que mudou de posição relativa. Sub-árvores com a mesma
 * referência são puladas, então o custo é proporcional ao que mudou.
 *
 * Deve rodar dentro de `doc.transact(..., origin)`. Devolve se escreveu algo.
 */
export function applyDiff(doc: Y.Doc, before: ProjectDoc, after: ProjectDoc, stamp: Stamp = {}): boolean {
  const r = roots(doc);
  let any = false;
  if (r.meta.get('name') !== after.name) {
    r.meta.set('name', after.name);
    any = true;
  }
  if (r.meta.get('modelVersion') !== MODEL_VERSION) r.meta.set('modelVersion', MODEL_VERSION);
  if (before.schema !== after.schema) {
    any = diffEntityList(r.tables, before.schema.tables, after.schema.tables, writeTable, stamp) || any;
    any = diffEntityList(r.enums, before.schema.enums, after.schema.enums, writeEnum, stamp) || any;
    any = diffEntityList(r.relationships, before.schema.relationships, after.schema.relationships, writeRelationship, stamp) || any;
  }
  any = diffRecord(r.layout, before.layout, after.layout, writeLayout) || any;
  any = diffRecord(r.entityMeta, before.meta, after.meta, writeMeta) || any;
  any = diffEntityList(r.notes, before.notes, after.notes, writeNote, stamp) || any;
  return any;
}

/** Escreve um projeto inteiro num documento vazio (import, migração do IndexedDB antigo, testes) */
export function writeProject(doc: Y.Doc, p: ProjectDoc, stamp: Stamp = {}) {
  applyDiff(doc, emptyProjectDoc(''), p, stamp);
}

/** `Project` → update Yjs (o que o import de `.zip` manda para um canvas novo) */
export function fromProject(p: ProjectDoc, stamp: Stamp = {}): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => writeProject(doc, p, stamp));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
