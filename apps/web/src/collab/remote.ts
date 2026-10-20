import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { colorOf, StatelessZ, type Role, type Stateless } from '@erd/contracts';
import { api, ok } from '../api/client';
import { warmupWorkers } from '../sync/parserClient';
import { useEditorContext } from '../store/useEditorContext';
import { bindPresence } from './presence';
import { createUndoManager, type BotChannel, type Session } from './session';

export interface RemoteOptions {
  canvasId: string;
  userId: string;
  readOnly: boolean;
  role: Role;
  /** Índice da cor do membro no projeto (§5.1) */
  color: number;
  name: string;
  /** Mensagens do servidor fora do documento (mudança de papel, versão restaurada) */
  onStateless?: (m: Stateless) => void;
  onAccessLost?: (reason: string) => void;
}

export const collabUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;

/**
 * Canvas na nuvem, em tempo real (fase 3): o `Y.Doc` conversa com o Hocuspocus pelo
 * `HocuspocusProvider` (um WebSocket por aba, reconexão e sincronização incremental), com
 * cópia local no `y-indexeddb` para abrir rápido e continuar offline. O sync bot roda no
 * servidor; aqui ficam só o lint local e o canal de mensagens até ele.
 */
export async function openRemoteSession(o: RemoteOptions): Promise<Session> {
  warmupWorkers();
  const setConn = (connection: 'connecting' | 'synced' | 'syncing' | 'offline') => useEditorContext.getState().set({ connection });
  setConn('connecting');
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(`erd-canvas-${o.canvasId}`, doc);
  await idb.whenSynced;

  const provider = new HocuspocusProvider({
    url: collabUrl(),
    name: `canvas:${o.canvasId}`,
    document: doc,
    // token curto (5 min), renovado sozinho a cada (re)conexão
    token: async () => (await ok(api.canvases[':id']['collab-token'].$post({ param: { id: o.canvasId } }))).token,
    onAuthenticationFailed: ({ reason }) => o.onAccessLost?.(reason),
    onStateless: ({ payload }) => {
      const r = StatelessZ.safeParse(JSON.parse(payload));
      if (r.success) o.onStateless?.(r.data);
    },
  });

  const refresh = () => {
    const status = (provider as unknown as { configuration: { websocketProvider: { status: string } } }).configuration.websocketProvider.status;
    if (status !== 'connected') setConn('offline');
    else if (!provider.isSynced || provider.unsyncedChanges > 0) setConn('syncing');
    else setConn('synced');
  };
  provider.on('status', refresh);
  provider.on('synced', refresh);
  provider.on('unsyncedChanges', refresh);
  provider.on('disconnect', refresh);
  // o navegador avisa quando a rede cai: não espera o timeout do WebSocket para mostrar "Offline"
  const goOffline = () => {
    provider.disconnect();
    setConn('offline');
  };
  const goOnline = () => void provider.connect();
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', goOnline);

  // espera a primeira sincronização; offline, segue com a cópia local
  await new Promise<void>((resolve) => {
    if (provider.isSynced) return resolve();
    const done = () => {
      clearTimeout(t);
      provider.off('synced', done);
      resolve();
    };
    const t = setTimeout(done, doc.share.size ? 4000 : 15000);
    provider.on('synced', done);
  });
  refresh();

  const send = (m: Stateless) => provider.sendStateless(JSON.stringify(m));
  const bot: BotChannel = {
    flush: (format) => send({ type: 'flush', format }),
    resolve: (format, id, choice) => send({ type: 'resolve', format, id, choice }),
    clearDivergent: (format) => send({ type: 'clear-divergent', format }),
  };

  const undo = createUndoManager(doc);
  const awareness = provider.awareness!;
  const session: Session = {
    key: `canvas:${o.canvasId}`,
    doc,
    awareness,
    undo,
    bot,
    userId: o.userId,
    readOnly: o.readOnly,
    destroy() {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      offPresence();
      undo.destroy();
      provider.destroy();
      void idb.destroy();
      doc.destroy();
    },
  };
  const offPresence = bindPresence(session, { id: o.userId, name: o.name, color: colorOf(o.color) });
  return session;
}
