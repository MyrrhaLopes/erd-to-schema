import { create } from 'zustand';
import type { Awareness } from 'y-protocols/awareness';
import type { Format, Id } from '@erd/model/types';
import type { Session } from '../session';

/**
 * Estado efêmero de cada pessoa (§5.2), publicado pela awareness — nada disso é persistido.
 * O ponteiro do canvas se chama `pointer` (e não `cursor`): o `y-codemirror.next` usa o campo
 * `cursor` da mesma awareness para o cursor de texto.
 */
export interface PresenceState {
  user: { id: string; name: string; color: string; colorLight: string };
  /** Coordenadas do canvas (flow), não da tela */
  pointer?: { x: number; y: number; at: number } | null;
  selection?: { nodes: Id[]; edges: Id[] } | null;
  editing?: { entityId: Id; field?: string } | null;
  dragging?: { id: Id; x: number; y: number }[] | null;
  /** Em qual painel está e em qual entidade o cursor de texto está */
  panel?: { format: Format; entityId?: Id } | null;
  viewport?: { x: number; y: number; zoom: number; w: number; h: number } | null;
}

export interface Peer extends PresenceState {
  clientId: number;
}

export interface PeerLite {
  clientId: number;
  userId: string;
  name: string;
  color: string;
}

/** O que cada nó do canvas mostra sobre os outros (§5.3) */
export interface NodePresence {
  selectedBy: PeerLite[];
  editingBy?: PeerLite & { field?: string };
  /** Quem está com o cursor de texto dentro da definição desta entidade num painel */
  codeBy: PeerLite[];
}

interface PresenceStore {
  peers: Peer[];
  /** Posição ao vivo de nós que outra pessoa está arrastando (§4.5) */
  drags: Map<Id, { x: number; y: number; color: string; name: string }>;
  nodes: Map<Id, NodePresence>;
  /** Aresta selecionada por alguém → cor dessa pessoa */
  edges: Map<Id, string>;
  /** Quem está em cada aba de formato (bolinhas no seletor de abas) */
  panels: Map<Format, PeerLite[]>;
  /** "Seguir" (§5.3): o clientId da pessoa seguida */
  following: number | null;
  /** Quando (no relógio local) o ponteiro de cada pessoa mexeu pela última vez */
  pointerSeen: Map<number, number>;
}

export const usePresence = create<PresenceStore>(() => ({ peers: [], drags: new Map(), nodes: new Map(), edges: new Map(), panels: new Map(), following: null, pointerSeen: new Map() }));

/** Diretório de pessoas do projeto (userId → nome e cor), para autoria e erros com dono */
interface Directory {
  people: Map<string, { name: string; color: string }>;
  me: string | null;
  add: (list: { id: string; name: string; color: string }[]) => void;
}
export const useDirectory = create<Directory>((set) => ({
  people: new Map(),
  me: null,
  add: (list) =>
    set((s) => {
      let changed = false;
      const next = new Map(s.people);
      for (const p of list) {
        const cur = next.get(p.id);
        if (cur?.name === p.name && cur.color === p.color) continue;
        next.set(p.id, { name: p.name, color: p.color });
        changed = true;
      }
      return changed ? { people: next } : s;
    }),
}));

export const personOf = (userId: string | undefined) => (userId ? useDirectory.getState().people.get(userId) : undefined);

const lighten = (hex: string) => hex + '33';

const lite = (p: Peer): PeerLite => ({ clientId: p.clientId, userId: p.user.id, name: p.user.name, color: p.user.color });

/** Deriva, a partir das awareness, o que cada nó/aresta/aba mostra */
function derive(peers: Peer[]) {
  const drags = new Map<Id, { x: number; y: number; color: string; name: string }>();
  const nodes = new Map<Id, NodePresence>();
  const edges = new Map<Id, string>();
  const panels = new Map<Format, PeerLite[]>();
  const at = (id: Id) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { selectedBy: [], codeBy: [] }));
    return n;
  };
  for (const p of peers) {
    const l = lite(p);
    for (const d of p.dragging ?? []) drags.set(d.id, { x: d.x, y: d.y, color: p.user.color, name: p.user.name });
    for (const id of p.selection?.nodes ?? []) at(id).selectedBy.push(l);
    for (const id of p.selection?.edges ?? []) if (!edges.has(id)) edges.set(id, p.user.color);
    if (p.editing) at(p.editing.entityId).editingBy = { ...l, field: p.editing.field };
    if (p.panel) {
      panels.set(p.panel.format, [...(panels.get(p.panel.format) ?? []), l]);
      if (p.panel.entityId) at(p.panel.entityId).codeBy.push(l);
    }
  }
  return { drags, nodes, edges, panels };
}

export function bindPresence(session: Session, user: { id: string; name: string; color: string }): () => void {
  const aw: Awareness = session.awareness;
  aw.setLocalStateField('user', { ...user, colorLight: lighten(user.color) });
  useDirectory.setState({ me: user.id });
  useDirectory.getState().add([user]);
  const update = () => {
    const peers: Peer[] = [];
    for (const [clientId, raw] of aw.getStates()) {
      if (clientId === aw.clientID) continue;
      const st = raw as Partial<PresenceState>;
      if (!st.user) continue;
      peers.push({ ...(st as PresenceState), clientId });
    }
    useDirectory.getState().add(peers.map((p) => p.user));
    const prev = usePresence.getState();
    // relógio local (os relógios das máquinas não batem): quando cada ponteiro mexeu por último
    const pointerSeen = new Map<number, number>();
    for (const p of peers) {
      const old = prev.peers.find((x) => x.clientId === p.clientId);
      const moved = !old || old.pointer?.x !== p.pointer?.x || old.pointer?.y !== p.pointer?.y;
      pointerSeen.set(p.clientId, moved ? Date.now() : (prev.pointerSeen.get(p.clientId) ?? Date.now()));
    }
    const following = prev.following;
    usePresence.setState({ peers, ...derive(peers), pointerSeen, following: following !== null && peers.some((p) => p.clientId === following) ? following : null });
  };
  aw.on('change', update);
  update();
  return () => {
    aw.off('change', update);
    usePresence.setState({ peers: [], drags: new Map(), nodes: new Map(), edges: new Map(), panels: new Map(), following: null, pointerSeen: new Map() });
  };
}

/** Atualiza campos do estado local de presença (só o que mudou, para não inundar a rede) */
export function setPresence(session: Session | null, patch: Partial<PresenceState>) {
  if (!session) return;
  const cur = (session.awareness.getLocalState() ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (JSON.stringify(cur[k]) !== JSON.stringify(v)) session.awareness.setLocalStateField(k, v);
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

/** Uma pessoa por usuário (a mesma conta em duas abas aparece uma vez) */
export function uniquePeople(peers: Peer[]): Peer[] {
  const seen = new Set<string>();
  return peers.filter((p) => !seen.has(p.user.id) && seen.add(p.user.id));
}
