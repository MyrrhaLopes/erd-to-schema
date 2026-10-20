import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { placeNewEntities } from '@erd/model/project';
import { LOAD_ORIGIN, roots, writeProject } from '@erd/crdt';
import { SyncBot } from '@erd/sync';
import { parseInWorker, warmupWorkers } from '../sync/parserClient';
import { loadSaved } from '../persistence/indexedDb';
import { storeView } from '../store/useProjectStore';
import { buildSampleProject } from './sample';
import { createAwareness, createUndoManager, type Session } from './session';

export const LOCAL_KEY = 'erd-local';

/**
 * Modo local (§10): sem conta e sem servidor. O mesmo Y.Doc, persistido pelo `y-indexeddb`,
 * com o sync bot rodando no próprio browser (com um só usuário há um só escritor).
 */
export async function openLocalSession(): Promise<Session> {
  warmupWorkers();
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(LOCAL_KEY, doc);
  await idb.whenSynced;

  const r = roots(doc);
  if (!r.meta.has('name') && r.tables.size === 0 && r.notes.size === 0) {
    // primeira abertura: converte o projeto do autosave antigo (JSON no IndexedDB) ou carrega o exemplo
    const legacy = await loadSaved();
    const p = legacy ?? (await buildSampleProject());
    placeNewEntities(p);
    doc.transact(() => writeProject(doc, p), LOAD_ORIGIN);
    storeView(LOCAL_KEY, p.view);
  }

  const bot = new SyncBot(doc, { parse: parseInWorker, onError: (e) => console.error('[sync-bot]', e) }).start();
  const undo = createUndoManager(doc);
  const awareness = createAwareness(doc);
  return {
    key: LOCAL_KEY,
    doc,
    awareness,
    undo,
    bot,
    userId: 'local',
    readOnly: false,
    destroy() {
      bot.stop();
      undo.destroy();
      awareness.destroy();
      void idb.destroy();
      doc.destroy();
    },
  };
}
