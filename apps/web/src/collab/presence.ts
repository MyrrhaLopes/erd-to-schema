import { create } from 'zustand';
import type { Awareness } from 'y-protocols/awareness';
import type { Format, Id } from '@erd/model/types';
import type { Session } from './session';

/** Estado efêmero de cada pessoa (§5.2), publicado pela awareness — nada disso é persistido */
export interface PresenceState {
  user: { id: string; name: string; color: string; colorLight: string };
  /** Coordenadas do canvas (flow), não da tela */
  cursor?: { x: number; y: number; at: number } | null;
  selection?: Id[];
  editing?: { entityId: Id; field?: string } | null;
  dragging?: { id: Id; x: number; y: number }[] | null;
  panel?: { format: Format; entityId?: Id } | null;
  viewport?: { x: number; y: number; zoom: number };
}

export interface Peer extends PresenceState {
  clientId: number;
}

interface PresenceStore {
  peers: Peer[];
  /** Posição ao vivo de nós que outra pessoa está arrastando (§4.5) */
  drags: Map<Id, { x: number; y: number; color: string; name: string }>;
}

export const usePresence = create<PresenceStore>(() => ({ peers: [], drags: new Map() }));

const lighten = (hex: string) => hex + '33';

export function bindPresence(session: Session, user: { id: string; name: string; color: string }): () => void {
  const aw: Awareness = session.awareness;
  aw.setLocalStateField('user', { ...user, colorLight: lighten(user.color) });
  const update = () => {
    const peers: Peer[] = [];
    const drags = new Map<Id, { x: number; y: number; color: string; name: string }>();
    for (const [clientId, raw] of aw.getStates()) {
      if (clientId === aw.clientID) continue;
      const st = raw as Partial<PresenceState>;
      if (!st.user) continue;
      const p = { ...(st as PresenceState), clientId };
      peers.push(p);
      for (const d of p.dragging ?? []) drags.set(d.id, { x: d.x, y: d.y, color: p.user.color, name: p.user.name });
    }
    usePresence.setState({ peers, drags });
  };
  aw.on('change', update);
  update();
  return () => {
    aw.off('change', update);
    usePresence.setState({ peers: [], drags: new Map() });
  };
}

/** Atualiza campos do estado local de presença */
export function setPresence(session: Session | null, patch: Partial<PresenceState>) {
  if (!session) return;
  for (const [k, v] of Object.entries(patch)) session.awareness.setLocalStateField(k, v);
}

/** Limita a frequência (o arraste vai a ~30 Hz pela awareness) */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  return (...a: A) => {
    const now = Date.now();
    pending = a;
    if (now - last >= ms) {
      last = now;
      fn(...a);
      pending = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
}
