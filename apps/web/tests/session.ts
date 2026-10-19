import * as Y from 'yjs';
import { createAwareness, createUndoManager, type Session } from '../src/collab/session';
import { activateSession } from '../src/collab/openCanvas';

/** Sessão em memória (sem bot nem rede), para testar ações e store sobre o Y.Doc */
export function memorySession(doc = new Y.Doc()): Session {
  const undo = createUndoManager(doc);
  const awareness = createAwareness(doc);
  const s: Session = {
    key: 'test',
    doc,
    awareness,
    undo,
    bot: { flush() {}, resolve() {}, clearDivergent() {} },
    userId: 'tester',
    readOnly: false,
    destroy() {
      undo.destroy();
      awareness.destroy();
    },
  };
  activateSession(s);
  return s;
}
