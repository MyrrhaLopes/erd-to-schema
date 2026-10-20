import { useEffect, useMemo, useState } from 'react';
import { useReactFlow, useViewport, type Node, type NodeProps, type Viewport } from '@xyflow/react';
import { Eye } from 'lucide-react';
import { useUi } from '../../store/useUi';
import { getSession } from '../session';
import { useSession } from '../useSession';
import { setPresence, throttle, uniquePeople, usePresence, type Peer } from './index';
import { bindRecent, bindStamps } from './authorship';
import { initials } from './NodeDecor';

/** O ponteiro some depois de alguns segundos parado (§5.3) */
const POINTER_IDLE_MS = 5000;

/** Cursores remotos no canvas, com o nome na cor de cada pessoa */
export function RemoteCursors() {
  const peers = usePresence((s) => s.peers);
  const seen = usePresence((s) => s.pointerSeen);
  const { x, y, zoom } = useViewport();
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {peers
        .filter((p) => p.pointer && now - (seen.get(p.clientId) ?? now) < POINTER_IDLE_MS)
        .map((p) => (
          <div
            key={p.clientId}
            data-testid="remote-cursor"
            className="absolute left-0 top-0 transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${p.pointer!.x * zoom + x}px, ${p.pointer!.y * zoom + y}px)` }}
          >
            <svg width="16" height="18" viewBox="0 0 16 18" style={{ filter: 'drop-shadow(0 1px 1px rgb(0 0 0 / .25))' }}>
              <path d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z" fill={p.user.color} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span
              className="absolute left-3.5 top-4 whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-medium text-white shadow"
              style={{ background: p.user.color }}
              data-color={p.user.color}
            >
              {p.user.name}
            </span>
          </div>
        ))}
    </div>
  );
}

/** Nó invisível que marca, no minimapa, o centro da tela de cada pessoa */
export type PeerDotNode = Node<{ color: string; name: string }, 'peer'>;
export function PeerDot() {
  return <div className="erd-peer-dot erd-export-hide" style={{ width: 1, height: 1 }} />;
}

/** Centro do que cada pessoa está vendo, como nós `peer` (só para o minimapa) */
export function usePeerDots(): PeerDotNode[] {
  const peers = usePresence((s) => s.peers);
  return useMemo(
    () =>
      uniquePeople(peers)
        .filter((p) => p.viewport)
        .map((p) => {
          const v = p.viewport!;
          return {
            id: `peer:${p.clientId}`,
            type: 'peer' as const,
            position: { x: (v.w / 2 - v.x) / v.zoom - 40, y: (v.h / 2 - v.y) / v.zoom - 40 },
            width: 80,
            height: 80,
            data: { color: p.user.color, name: p.user.name },
            selectable: false,
            draggable: false,
            connectable: false,
            focusable: false,
            className: 'erd-peer-dot',
          };
        }),
    [peers],
  );
}

const publishPointer = throttle((p: { x: number; y: number } | null) => setPresence(getSession(), { pointer: p ? { x: Math.round(p.x), y: Math.round(p.y), at: Date.now() } : null }), 50);
const publishViewport = throttle(
  (v: Viewport, s: { w: number; h: number }) => setPresence(getSession(), { viewport: { x: Math.round(v.x), y: Math.round(v.y), zoom: +v.zoom.toFixed(3), ...s } }),
  120,
);

/** Publica na awareness o que esta pessoa está fazendo no canvas e aplica o "seguir" */
export function useCanvasPresence(wrapper: React.RefObject<HTMLDivElement | null>) {
  const rf = useReactFlow();
  const session = useSession();
  const selectedNodes = useUi((s) => s.selectedNodes);
  const selectedEdges = useUi((s) => s.selectedEdges);
  const editing = useUi((s) => s.editing);
  const showAuthorship = useUi((s) => s.showAuthorship);
  const following = usePresence((s) => s.following);
  const followed = usePresence((s) => (s.following === null ? undefined : s.peers.find((p) => p.clientId === s.following)));

  useEffect(() => {
    if (!session) return;
    return bindRecent(session);
  }, [session]);

  useEffect(() => {
    if (!session || !showAuthorship) return;
    return bindStamps(session);
  }, [session, showAuthorship]);

  useEffect(() => setPresence(session, { selection: selectedNodes.length || selectedEdges.length ? { nodes: selectedNodes, edges: selectedEdges } : null }), [session, selectedNodes, selectedEdges]);

  useEffect(() => {
    const field = editing?.kind === 'column' ? editing.colId : editing?.kind === 'table-name' ? 'name' : undefined;
    setPresence(session, { editing: editing ? { entityId: editing.id, field } : null });
  }, [session, editing]);

  const size = () => ({ w: wrapper.current?.clientWidth ?? 0, h: wrapper.current?.clientHeight ?? 0 });

  // a viewport inicial também vai (sem esperar a pessoa mexer)
  useEffect(() => {
    if (session) publishViewport(rf.getViewport(), { w: wrapper.current?.clientWidth ?? 0, h: wrapper.current?.clientHeight ?? 0 });
  }, [session, rf, wrapper]);

  // seguir: a minha tela acompanha o centro e o zoom da tela da pessoa seguida
  useEffect(() => {
    const v = followed?.viewport;
    const el = wrapper.current;
    if (!v || !el) return;
    const cx = (v.w / 2 - v.x) / v.zoom;
    const cy = (v.h / 2 - v.y) / v.zoom;
    void rf.setViewport({ x: el.clientWidth / 2 - cx * v.zoom, y: el.clientHeight / 2 - cy * v.zoom, zoom: v.zoom }, { duration: 150 });
  }, [followed?.viewport, rf, wrapper]);

  return {
    onPointerMove: (e: React.PointerEvent) => publishPointer(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })),
    onPointerLeave: () => publishPointer(null),
    onMove: (_e: unknown, v: Viewport) => publishViewport(v, size()),
    /** Mexer na tela por conta própria para de seguir */
    onMoveStart: (e: MouseEvent | TouchEvent | null) => {
      if (e && following !== null) usePresence.setState({ following: null });
    },
  };
}

/** Pilha de avatares de quem está online (§5.3); clicar segue a pessoa */
export function PeerAvatars() {
  const peers = usePresence((s) => s.peers);
  const following = usePresence((s) => s.following);
  const people = uniquePeople(peers);
  if (!people.length) return null;
  const follow = (p: Peer) => usePresence.setState({ following: following === p.clientId ? null : p.clientId });
  return (
    <div className="mr-1 flex items-center -space-x-1.5" data-testid="peer-avatars">
      {people.slice(0, 6).map((p) => (
        <button
          key={p.clientId}
          onClick={() => follow(p)}
          title={following === p.clientId ? `Parar de seguir ${p.user.name}` : `Seguir ${p.user.name}`}
          className={'relative inline-flex h-7 w-7 items-center justify-center rounded-full text-[10.5px] font-bold text-white ring-2 ' + (following === p.clientId ? 'ring-slate-800' : 'ring-white')}
          style={{ background: p.user.color }}
          data-testid="peer-avatar"
        >
          {initials(p.user.name)}
          {following === p.clientId && (
            <span className="absolute -bottom-1 -right-1 rounded-full bg-slate-800 p-0.5 text-white">
              <Eye size={8} />
            </span>
          )}
        </button>
      ))}
      {people.length > 6 && <span className="inline-flex h-7 items-center rounded-full bg-slate-500 px-1.5 text-[10px] text-white ring-2 ring-white">+{people.length - 6}</span>}
    </div>
  );
}

/** Faixa "Seguindo Fulana" no canvas */
export function FollowBanner() {
  const p = usePresence((s) => (s.following === null ? undefined : s.peers.find((x) => x.clientId === s.following)));
  if (!p) return null;
  return (
    <div className="absolute left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1 text-[11.5px] font-medium text-white shadow" style={{ background: p.user.color }} data-testid="follow-banner">
      <Eye size={12} /> Seguindo {p.user.name}
      <button className="ml-1 underline" onClick={() => usePresence.setState({ following: null })}>
        parar
      </button>
    </div>
  );
}

export const presenceNodeTypes = { peer: PeerDot as (p: NodeProps<PeerDotNode>) => React.ReactElement };
