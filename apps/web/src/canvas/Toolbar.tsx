import { Eraser, Hand, MousePointer2, Spline, StickyNote, Table2 } from 'lucide-react';
import type { Tool } from '@erd/model/types';
import { useProjectStore } from '../store/useProjectStore';
import { useUi, type RelationMode } from '../store/useUi';

const TOOLS: { tool: Tool; icon: typeof Hand; label: string; key: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Seleção', key: 'V / 1' },
  { tool: 'hand', icon: Hand, label: 'Mão (pan)', key: 'H · Espaço' },
  { tool: 'table', icon: Table2, label: 'Tabela', key: 'R / 2' },
  { tool: 'relation', icon: Spline, label: 'Relação', key: 'A / 3' },
  { tool: 'note', icon: StickyNote, label: 'Nota', key: 'T / 4' },
  { tool: 'eraser', icon: Eraser, label: 'Borracha', key: 'E / 0' },
];

const MODES: { mode: RelationMode; label: string; title: string }[] = [
  { mode: 'fk', label: 'FK', title: 'Chave estrangeira real (gera FOREIGN KEY)' },
  { mode: 'note', label: 'Nota', title: 'Relação somente de nota (não gera FK)' },
  { mode: 'nn', label: 'N:N', title: 'Muitos-para-muitos: cria tabela pivot' },
];

export function Toolbar() {
  const tool = useProjectStore((s) => s.tool);
  const setTool = useProjectStore((s) => s.setTool);
  const mode = useUi((s) => s.relationMode);
  const set = useUi((s) => s.set);

  return (
    <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-slate-200 bg-white/95 p-1 shadow-md backdrop-blur">
      {TOOLS.map(({ tool: t, icon: Icon, label, key }, i) => (
        <button
          key={t}
          title={`${label} — ${key}`}
          onClick={() => {
            setTool(t);
            set({ relationSource: null });
          }}
          className={
            'relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ' +
            (tool === t ? 'bg-indigo-100 text-indigo-700' : 'text-slate-600 hover:bg-slate-100')
          }
        >
          <Icon size={17} strokeWidth={1.8} />
          <span className="absolute bottom-0.5 right-1 text-[8px] text-slate-400">{t === 'hand' ? 'H' : t === 'eraser' ? 0 : i === 0 ? 1 : i}</span>
        </button>
      ))}
      {tool === 'relation' && (
        <>
          <div className="mx-1 h-6 w-px bg-slate-200" />
          <div className="flex items-center gap-0.5" title="Tipo de relação criada ao conectar">
            {MODES.map((m) => (
              <button
                key={m.mode}
                title={m.title}
                onClick={() => set({ relationMode: m.mode })}
                className={
                  'h-7 rounded-md px-2 text-[11px] font-medium ' +
                  (mode === m.mode
                    ? m.mode === 'note'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-indigo-100 text-indigo-700'
                    : 'text-slate-500 hover:bg-slate-100')
                }
              >
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
