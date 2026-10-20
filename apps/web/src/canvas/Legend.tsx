import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { COLORS, markerId, type ColorKey, type EndMark } from './edges/edges';

const LINES: { variant: ColorKey; dash?: string; label: string; detail: string }[] = [
  { variant: 'fk', label: 'FK real', detail: 'Chave estrangeira — gera FOREIGN KEY' },
  { variant: 'note', dash: '7 5', label: 'Relação-nota', detail: 'Só anotação — não gera FK' },
  { variant: 'nn', dash: '2 4', label: 'N:N', detail: 'Via tabela pivot (oculta)' },
  { variant: 'enum', dash: '3 3', label: 'Referência a enum', detail: 'Coluna usa os valores do enum' },
];

const MARKS: { kind: EndMark; label: string }[] = [
  { kind: 'one', label: 'Exatamente um' },
  { kind: 'zero-one', label: 'Zero ou um' },
  { kind: 'many', label: 'Muitos' },
  { kind: 'zero-many', label: 'Zero ou muitos' },
  { kind: 'one-many', label: 'Um ou muitos' },
];

function LineSample({ variant, dash }: { variant: ColorKey; dash?: string }) {
  return (
    <svg width={42} height={20} viewBox="0 0 42 20" className="shrink-0 overflow-visible">
      <line x1={2} y1={10} x2={28} y2={10} stroke={COLORS[variant]} strokeWidth={1.5} strokeDasharray={dash} markerEnd={`url(#${markerId('many', variant)})`} />
    </svg>
  );
}

function MarkSample({ kind }: { kind: EndMark }) {
  return (
    <svg width={42} height={20} viewBox="0 0 42 20" className="shrink-0 overflow-visible">
      <line x1={2} y1={10} x2={28} y2={10} stroke={COLORS.fk} strokeWidth={1.5} markerEnd={`url(#${markerId(kind, 'fk')})`} />
    </svg>
  );
}

/** Sempre presente no canto inferior esquerdo do canvas — alterna como a janela de propriedades */
export function Legend() {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="absolute bottom-3 left-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[230px] flex-col rounded-xl border border-slate-200 bg-white/97 shadow-lg">
      <button className="flex items-center justify-between px-3 py-2 text-[12px] font-semibold text-slate-700" onClick={() => setCollapsed(!collapsed)}>
        Legenda
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {!collapsed && (
        <div className="overflow-y-auto">
          <div className="space-y-1.5 border-t border-slate-100 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tipos de relação</div>
            {LINES.map((l) => (
              <div key={l.variant} className="flex items-center gap-2" title={l.detail}>
                <LineSample variant={l.variant} dash={l.dash} />
                <span className="text-[11px] text-slate-600">{l.label}</span>
              </div>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-slate-100 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Cardinalidade (pé-de-galinha)</div>
            {MARKS.map((m) => (
              <div key={m.kind} className="flex items-center gap-2">
                <MarkSample kind={m.kind} />
                <span className="text-[11px] text-slate-600">{m.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
