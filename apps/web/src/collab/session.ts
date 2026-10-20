import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { Format } from '@erd/model/types';
import { LOCAL_ORIGIN, modelTypes } from '@erd/crdt';

/**
 * Canal até o sync bot do documento. No modo local o bot roda neste browser e as
 * chamadas são diretas; com servidor, viram *stateless messages* do Hocuspocus.
 */
export interface BotChannel {
  flush(f: Format): void;
  resolve(f: Format, divergenceId: string, choice: 'text' | 'diagram'): void;
  clearDivergent(f: Format): void;
}

export type ConnectionState = 'local' | 'connecting' | 'synced' | 'syncing' | 'offline';

/**
 * Um canvas aberto: o Y.Doc e tudo o que vive enquanto ele está na tela. `openCanvas`
 * cria; `closeCanvas` desfaz tudo ao trocar de rota, para nada vazar entre projetos.
 */
export interface Session {
  key: string;
  doc: Y.Doc;
  awareness: Awareness;
  undo: Y.UndoManager;
  bot: BotChannel;
  userId: string;
  readOnly: boolean;
  destroy(): void;
}

let current: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();

export function getSession(): Session | null {
  return current;
}

export function onSessionChange(fn: (s: Session | null) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function setSession(s: Session | null) {
  if (current && current !== s) current.destroy();
  current = s;
  for (const fn of listeners) fn(s);
}

/** Undo global: só as mudanças deste cliente no modelo (Ctrl+Z nunca desfaz o colega) */
export function createUndoManager(doc: Y.Doc) {
  return new Y.UndoManager(modelTypes(doc), { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
}

export function createAwareness(doc: Y.Doc) {
  return new Awareness(doc);
}
