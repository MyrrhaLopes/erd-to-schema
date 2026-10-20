import * as Y from 'yjs';
import { parse as pgParse } from 'libpg-query';
import type { Format } from '@erd/model/types';
import type { ParseOutcome } from '@erd/model/formats/common';
import { parseSql } from '@erd/model/formats/sql/parse';
import { parsePrisma } from '@erd/model/formats/prisma/parse';
import { parseDrizzle } from '@erd/model/formats/drizzle/parse';
import { codeText, projectDoc, roots } from '@erd/crdt';
import { SyncBot } from '../src';

export const parse = async (f: Format, text: string): Promise<ParseOutcome> =>
  f === 'sql' ? parseSql(text, pgParse as never) : f === 'prisma' ? parsePrisma(text) : parseDrizzle(text);

export function newBot(doc: Y.Doc) {
  return new SyncBot(doc, { parse, debounceMs: 5 }).start();
}

export const text = (doc: Y.Doc, f: Format) => codeText(doc, f).toString();
export const tableNames = (doc: Y.Doc) => projectDoc(doc).schema.tables.map((t) => t.name);

/** Um cliente: só digita (nunca traduz) */
export function client(name: string, server: Y.Doc) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  doc.transact(() => roots(doc).clients.set(String(doc.clientID), name));
  return doc;
}

/** Troca todos os updates pendentes entre os documentos (como o servidor faria) */
export function syncAll(...docs: Y.Doc[]) {
  for (let round = 0; round < 2; round++)
    for (const a of docs)
      for (const b of docs) {
        if (a === b) continue;
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
      }
}

export function typeAt(doc: Y.Doc, f: Format, find: string | number, insert: string, after = true) {
  const t = codeText(doc, f);
  const s = t.toString();
  const at = typeof find === 'number' ? find : s.indexOf(find) + (after ? find.length : 0);
  if (typeof find === 'string' && s.indexOf(find) < 0) throw new Error('não achei: ' + find);
  t.insert(at, insert);
}

export function replaceIn(doc: Y.Doc, f: Format, find: string, rep: string) {
  const t = codeText(doc, f);
  const at = t.toString().indexOf(find);
  if (at < 0) throw new Error('não achei: ' + find);
  doc.transact(() => {
    t.delete(at, find.length);
    t.insert(at, rep);
  });
}
