import * as Y from 'yjs';
import type { Format, Project } from '@erd/model/types';
import { FORMATS } from '@erd/model/types';

/**
 * Forma do Y.Doc de um canvas ERD (§4.1 do plano). Tudo é indexado por ID estável;
 * a ordem é um campo `order` com índice fracionário, nunca a posição num array.
 *
 * Os painéis de código são `Y.Text` de topo (`code:sql`...), e não filhos de um Y.Map:
 * tipos de topo nascem pelo nome, então dois clientes criando o mesmo painel ao mesmo
 * tempo convergem para o mesmo texto em vez de um sobrescrever o outro.
 */
export const ROOTS = {
  meta: 'meta',
  tables: 'tables',
  enums: 'enums',
  relationships: 'relationships',
  layout: 'layout',
  entityMeta: 'entityMeta',
  notes: 'notes',
  sync: 'sync',
  clients: 'clients',
} as const;

/** Tipos que formam o modelo (projeção, undo, persistência do snapshot) */
export const MODEL_ROOTS = ['meta', 'tables', 'enums', 'relationships', 'layout', 'entityMeta', 'notes'] as const;
export type ModelRoot = (typeof MODEL_ROOTS)[number];

/** Projeto como aparece no documento compartilhado: sem `view`, que é preferência de cada pessoa */
export type ProjectDoc = Omit<Project, 'version' | 'view'>;

export const MODEL_VERSION = 1;

export type YEntity = Y.Map<unknown>;

export function roots(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>(ROOTS.meta),
    tables: doc.getMap<YEntity>(ROOTS.tables),
    enums: doc.getMap<YEntity>(ROOTS.enums),
    relationships: doc.getMap<YEntity>(ROOTS.relationships),
    layout: doc.getMap<YEntity>(ROOTS.layout),
    entityMeta: doc.getMap<YEntity>(ROOTS.entityMeta),
    notes: doc.getMap<YEntity>(ROOTS.notes),
    sync: doc.getMap<unknown>(ROOTS.sync),
    clients: doc.getMap<string>(ROOTS.clients),
  };
}

export const codeText = (doc: Y.Doc, f: Format): Y.Text => doc.getText(`code:${f}`);

export function codeTexts(doc: Y.Doc): Record<Format, Y.Text> {
  return Object.fromEntries(FORMATS.map((f) => [f, codeText(doc, f)])) as Record<Format, Y.Text>;
}

/** Todos os tipos rastreados pelo undo global (o modelo; os textos têm undo próprio no editor) */
export function modelTypes(doc: Y.Doc): Y.AbstractType<unknown>[] {
  const r = roots(doc);
  return MODEL_ROOTS.map((k) => r[k] as Y.AbstractType<unknown>);
}

/* ------------------------------------------------------------------ */
/* Origens das transações                                               */
/* ------------------------------------------------------------------ */

/** Edição feita por este cliente (canvas, inspector, notas): a única rastreada pelo undo */
export const LOCAL_ORIGIN = Object.freeze({ kind: 'local' as const });
/** Carga de projeto inteiro (abrir, exemplo, import): não entra no undo */
export const LOAD_ORIGIN = Object.freeze({ kind: 'load' as const });
/** Import de um texto solto para um painel */
export const IMPORT_ORIGIN = Object.freeze({ kind: 'import' as const });

export interface BotOrigin {
  kind: 'sync-bot';
  /** Formato cujo texto originou a mudança no modelo, ou `null` quando o bot só atualizou os textos */
  format: Format | null;
  changes?: string[];
}

export const isBotOrigin = (o: unknown): o is BotOrigin => !!o && typeof o === 'object' && (o as BotOrigin).kind === 'sync-bot';
