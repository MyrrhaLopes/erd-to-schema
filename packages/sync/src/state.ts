import * as Y from 'yjs';
import type { Format, Id } from '@erd/model/types';
import { roots } from '@erd/crdt';
import type { Diagnostic } from '@erd/model/formats/common';

/**
 * Estado de sincronização de cada painel, em `sync.<formato>` no Y.Doc. Escrito **só pelo
 * sync bot** (§4.1); os clientes leem para mostrar status, diagnósticos e blocos divergentes.
 * Posições são `Y.RelativePosition` serializadas: acompanham as edições no texto, então
 * um diagnóstico continua apontando para a linha certa mesmo depois de outra pessoa
 * digitar acima dele.
 */
export type RelPosJSON = Record<string, unknown>;

export interface RelRange {
  start: RelPosJSON;
  end: RelPosJSON;
}

/** Um bloco de topo do texto e as entidades que ele definiu no último parse */
export interface BlockRef extends RelRange {
  ids: Id[];
}

export interface SyncDiagnostic extends RelRange {
  severity: Diagnostic['severity'];
  message: string;
  /** userId de quem escreveu o trecho (erros "com dono", §5.4) */
  author?: string;
}

/** Bloco em que um patch modelo → texto não encaixou (§4.6, fluxo 2, item 4) */
export interface Divergence extends RelRange {
  id: string;
  ids: Id[];
  message: string;
}

export interface ChangeNote {
  id: string;
  items: string[];
  by?: string;
  at: number;
}

export interface FormatSync {
  v: 1;
  status: 'synced' | 'error';
  /** Hash do texto que o bot processou por último (diferente do atual = edição pendente) */
  textHash: string;
  /** Texto canônico do modelo que o texto reflete: base dos patches modelo → texto */
  base: string;
  /** Blocos do `base` (offsets absolutos no próprio `base`) e suas entidades */
  baseMap: { from: number; to: number; ids: Id[] }[];
  blocks: BlockRef[];
  diagnostics: SyncDiagnostic[];
  divergent: Divergence[];
  /** Última leva de mudanças aplicadas a partir deste texto (para o toast) */
  change?: ChangeNote;
}

export function readSync(doc: Y.Doc, f: Format): FormatSync | undefined {
  const v = roots(doc).sync.get(f) as FormatSync | undefined;
  return v && typeof v === 'object' && v.v === 1 ? v : undefined;
}

export function writeSync(doc: Y.Doc, f: Format, st: FormatSync) {
  roots(doc).sync.set(f, st);
}

export function relRange(text: Y.Text, from: number, to: number): RelRange {
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  };
}

/** Resolve um intervalo relativo para offsets atuais; `null` se o trecho sumiu */
export function resolveRange(doc: Y.Doc, r: RelRange): { from: number; to: number } | null {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.start), doc);
    const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.end), doc);
    if (!a || !b) return null;
    return { from: a.index, to: Math.max(a.index, b.index) };
  } catch {
    return null;
  }
}

/** Hash rápido (cyrb53) para saber se o texto mudou desde o último processamento */
export function hashText(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length;
}

/** clientID do Yjs que inseriu o caractere em `index` (para autoria por trecho) */
export function clientAt(text: Y.Text, index: number): number | undefined {
  let n = text._start;
  let pos = 0;
  while (n) {
    if (!n.deleted && n.countable) {
      if (index < pos + n.length) return n.id.client;
      pos += n.length;
    }
    n = n.right;
  }
  return undefined;
}

/** userId de quem escreveu o caractere em `index`, pelo mapa `clients` */
export function authorAt(doc: Y.Doc, text: Y.Text, index: number): string | undefined {
  const c = clientAt(text, index);
  return c === undefined ? undefined : roots(doc).clients.get(String(c));
}
