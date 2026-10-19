import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { SyncBot } from '@erd/sync';
import { getState, postUpdate } from '../api/client';
import { parseInWorker, warmupWorkers } from '../sync/parserClient';
import { useEditorContext } from '../store/useEditorContext';
import { createAwareness, createUndoManager, type Session } from './session';

/** Origem dos updates que vieram do servidor (não são reenviados) */
export const SERVER_ORIGIN = Object.freeze({ kind: 'server' as const });

export interface RemoteOptions {
  canvasId: string;
  userId: string;
  readOnly: boolean;
  role: 'owner' | 'editor' | 'viewer';
  /** Índice da cor do membro no projeto (§5.1) */
  color: number;
  name: string;
}

/**
 * Canvas na nuvem, ainda sem tempo real (fase 2): o estado vem da API, cada edição local
 * vira um update Yjs enviado pela API (agrupado e com retentativa), e o `y-indexeddb`
 * guarda uma cópia local para abrir rápido e não perder nada offline. O sync bot ainda
 * roda no browser, como no modo local.
 */
export async function openRemoteSession(o: RemoteOptions): Promise<Session> {
  warmupWorkers();
  const setConn = (connection: 'synced' | 'syncing' | 'offline') => useEditorContext.getState().set({ connection });
  setConn('syncing');
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(`erd-canvas-${o.canvasId}`, doc);
  await idb.whenSynced;
  const server = await getState(o.canvasId);
  const sv = (() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, server);
    const v = Y.encodeStateVector(d);
    d.destroy();
    return v;
  })();
  Y.applyUpdate(doc, server, SERVER_ORIGIN);

  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let destroyed = false;
  const flush = async () => {
    if (sending || !pending.length || destroyed) return;
    sending = true;
    const batch = Y.mergeUpdates(pending);
    pending = [];
    try {
      await postUpdate(o.canvasId, batch);
      setConn(pending.length ? 'syncing' : 'synced');
    } catch {
      // offline ou erro do servidor: volta para a fila e tenta de novo
      pending.unshift(batch);
      setConn('offline');
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 3000);
    } finally {
      sending = false;
      if (pending.length && !timer) timer = setTimeout(() => void flush(), 300);
    }
  };
  const schedule = () => {
    setConn('syncing');
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 500);
  };
  // edições feitas offline (guardadas no IndexedDB) e que o servidor ainda não tem
  if (!o.readOnly) {
    const missing = Y.encodeStateAsUpdate(doc, sv);
    if (missing.length > 2) {
      pending.push(missing);
      schedule();
    } else setConn('synced');
  } else setConn('synced');

  const onUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === SERVER_ORIGIN || origin === idb || o.readOnly) return;
    pending.push(u);
    schedule();
  };
  doc.on('update', onUpdate);
  const onUnload = () => void flush();
  window.addEventListener('beforeunload', onUnload);

  const bot = o.readOnly ? null : new SyncBot(doc, { parse: parseInWorker, onError: (e) => console.error('[sync-bot]', e) }).start();
  const undo = createUndoManager(doc);
  const awareness = createAwareness(doc);
  return {
    key: `canvas:${o.canvasId}`,
    doc,
    awareness,
    undo,
    bot: bot ?? { flush() {}, resolve() {}, clearDivergent() {} },
    userId: o.userId,
    readOnly: o.readOnly,
    destroy() {
      void flush();
      destroyed = true;
      window.removeEventListener('beforeunload', onUnload);
      doc.off('update', onUpdate);
      bot?.stop();
      undo.destroy();
      awareness.destroy();
      void idb.destroy();
      doc.destroy();
    },
  };
}
