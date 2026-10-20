import type { CSSProperties } from 'react';
import type { Id } from '@erd/model/types';
import { useUi } from '../../store/useUi';
import { useDirectory, usePresence, type PeerLite } from './index';
import { colKey, relTimeShort, useRecent, useStamps } from './authorship';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

function MiniAvatars({ people }: { people: PeerLite[] }) {
  const shown = people.slice(0, 3);
  return (
    <div className="erd-export-hide pointer-events-auto absolute -right-2 -top-3 z-10 flex -space-x-1.5" data-testid="node-avatars">
      {shown.map((p) => (
        <span
          key={p.clientId}
          title={p.name}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[8.5px] font-bold text-white ring-2 ring-white"
          style={{ background: p.color }}
        >
          {initials(p.name)}
        </span>
      ))}
      {people.length > 3 && <span className="inline-flex h-5 items-center rounded-full bg-slate-600 px-1 text-[8.5px] text-white ring-2 ring-white">+{people.length - 3}</span>}
    </div>
  );
}

/**
 * Tudo o que um nó mostra sobre as outras pessoas (§5.3) e sobre a autoria (§5.5), numa
 * camada por cima do nó: anel de seleção, mini-avatares, aviso de edição (soft lock), o
 * realce do que acabou de mudar e a borda do modo "Mostrar autoria". Os nós só incluem
 * `<NodeDecor id />`; nenhuma regra de presença mora dentro deles.
 */
export function NodeDecor({ id, radius = 10 }: { id: Id; radius?: number }) {
  const p = usePresence((s) => s.nodes.get(id));
  const recent = useRecent((s) => s.items.get(id));
  const showAuthorship = useUi((s) => s.showAuthorship);
  const stamp = useStamps((s) => (showAuthorship ? s.items.get(id) : undefined));
  const author = useDirectory((s) => (stamp ? s.people.get(stamp.by) : undefined));

  const around: PeerLite[] = [];
  for (const x of [...(p?.selectedBy ?? []), ...(p?.codeBy ?? [])]) if (!around.some((y) => y.userId === x.userId)) around.push(x);
  const ring = p?.editingBy?.color ?? around[0]?.color;
  const box = (inset: number, style: CSSProperties, testid?: string) => (
    <div data-testid={testid} className="erd-export-hide pointer-events-none absolute" style={{ inset: -inset, borderRadius: radius + inset, ...style }} />
  );

  return (
    <>
      {ring && box(5, { border: `2px solid ${ring}` }, 'peer-ring')}
      {recent && box(3, { boxShadow: `0 0 0 3px ${recent.color}`, animation: 'erd-recent 8s ease-out forwards' }, 'recent-change')}
      {stamp &&
        box(2, { border: `2px dashed ${author?.color ?? '#94a3b8'}` }, 'authorship')}
      {stamp && (
        <span
          className="erd-export-hide pointer-events-auto absolute -bottom-5 left-0 z-10 whitespace-nowrap rounded px-1.5 text-[9.5px] font-medium text-white"
          style={{ background: author?.color ?? '#94a3b8' }}
          title={`editado por ${author?.name ?? 'alguém'} ${relTimeShort(stamp.at)}`}
        >
          {author?.name ?? '?'} · {relTimeShort(stamp.at)}
        </span>
      )}
      {p?.editingBy && (
        <span
          data-testid="soft-lock"
          className="erd-export-hide pointer-events-none absolute -top-6 left-0 z-10 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
          style={{ background: p.editingBy.color }}
        >
          {p.editingBy.name} está editando
        </span>
      )}
      {around.length > 0 && <MiniAvatars people={around} />}
    </>
  );
}

/** Decoração de uma linha de coluna: realce recente, autoria e "editando esta coluna" */
export function useColumnDecor(tableId: Id, colId: Id): { style?: CSSProperties; title?: string } {
  const key = colKey(tableId, colId);
  const recent = useRecent((s) => s.items.get(key));
  const editingBy = usePresence((s) => {
    const e = s.nodes.get(tableId)?.editingBy;
    return e?.field === colId ? e : undefined;
  });
  const showAuthorship = useUi((s) => s.showAuthorship);
  const stamp = useStamps((s) => (showAuthorship ? s.items.get(key) : undefined));
  const author = useDirectory((s) => (stamp ? s.people.get(stamp.by) : undefined));
  if (editingBy) return { style: { background: editingBy.color + '26' }, title: `${editingBy.name} está editando esta coluna` };
  if (recent) return { style: { animation: 'erd-recent-row 8s ease-out forwards', ['--erd-c' as string]: recent.color + '40' }, title: `${recent.name} acabou de mudar` };
  if (stamp) return { style: { boxShadow: `inset 3px 0 0 ${author?.color ?? '#94a3b8'}` }, title: `editado por ${author?.name ?? 'alguém'} ${relTimeShort(stamp.at)}` };
  return {};
}
