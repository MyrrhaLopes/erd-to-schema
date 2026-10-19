import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { useUi } from '../store/useUi';
import { useProjectStore } from '../store/useProjectStore';
import { exportImage } from '../export/image';
import { slugify } from '@erd/model/naming';
import { FORMAT_LABEL, type Format } from '@erd/model/types';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-slate-800">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.v)}
          onClick={() => onChange(o.v)}
          className={'rounded-md px-2.5 py-1 text-[12px] ' + (value === o.v ? 'bg-white font-medium text-slate-800 shadow-sm' : 'text-slate-500')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  const set = useUi((s) => s.set);
  const name = useProjectStore((s) => s.name);
  const rf = useReactFlow();
  const [format, setFormat] = useState<'png' | 'pdf'>('png');
  const [scope, setScope] = useState<'selection' | 'all'>('selection');
  const [ratio, setRatio] = useState(2);
  const [bg, setBg] = useState<'white' | 'transparent'>('white');
  const [page, setPage] = useState<'image' | 'a4-landscape' | 'a4-portrait'>('image');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!open) return null;
  const selectedCount = rf.getNodes().filter((n) => n.selected).length;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await exportImage({
        nodes: rf.getNodes(),
        edges: rf.getEdges(),
        onlySelected: scope === 'selection',
        format,
        pixelRatio: ratio,
        background: format === 'pdf' ? 'white' : bg,
        pdfPage: page,
        fileName: slugify(name) + (scope === 'selection' && selectedCount ? '-selecao' : ''),
      });
      set({ exportOpen: false });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Exportar imagem" onClose={() => set({ exportOpen: false })}>
      <div className="space-y-3 text-[12.5px] text-slate-600">
        <div className="flex items-center justify-between">
          <span>Formato</span>
          <Seg value={format} onChange={setFormat} options={[{ v: 'png', label: 'PNG' }, { v: 'pdf', label: 'PDF' }]} />
        </div>
        <div className="flex items-center justify-between">
          <span>O quê</span>
          <Seg
            value={scope}
            onChange={setScope}
            options={[
              { v: 'selection', label: `Seleção (${selectedCount || 'nada → tudo'})` },
              { v: 'all', label: 'Diagrama inteiro' },
            ]}
          />
        </div>
        <div className="flex items-center justify-between">
          <span>Resolução</span>
          <Seg value={ratio} onChange={setRatio} options={[1, 2, 3].map((v) => ({ v, label: `${v}×` }))} />
        </div>
        {format === 'png' ? (
          <div className="flex items-center justify-between">
            <span>Fundo</span>
            <Seg value={bg} onChange={setBg} options={[{ v: 'white', label: 'Branco' }, { v: 'transparent', label: 'Transparente' }]} />
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span>Página</span>
            <Seg
              value={page}
              onChange={setPage}
              options={[
                { v: 'image', label: 'Tamanho da imagem' },
                { v: 'a4-landscape', label: 'A4 paisagem' },
                { v: 'a4-portrait', label: 'A4 retrato' },
              ]}
            />
          </div>
        )}
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="rounded-md px-3 py-1.5 hover:bg-slate-100" onClick={() => set({ exportOpen: false })}>
            Cancelar
          </button>
          <button disabled={busy} className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-50" onClick={run}>
            {busy ? 'Exportando…' : `Exportar ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['V ou 1', 'Seleção'],
  ['H · Espaço (segurar)', 'Mão / pan'],
  ['R ou 2', 'Tabela (clique no canvas)'],
  ['A ou 3', 'Relação (clique origem → destino, ou arraste entre colunas)'],
  ['T ou 4', 'Nota (Markdown)'],
  ['E ou 0', 'Borracha (arraste por cima; Esc cancela)'],
  ['Ctrl + Seta', 'Nova tabela na direção, com FK para a selecionada'],
  ['Ctrl + Shift + Seta', 'Nova tabela com relação-nota'],
  ['Ctrl + D', 'Duplicar tabela'],
  ['Enter · duplo clique', 'Renomear / editar'],
  ['Delete / Backspace', 'Excluir (cascata em FKs e pivots)'],
  ['Ctrl + Z · Ctrl + Shift + Z', 'Desfazer · refazer (fora dos editores)'],
  ['Ctrl + A', 'Selecionar tudo'],
  ['Shift + 1', 'Enquadrar tudo'],
  ['Ctrl + S (no editor)', 'Aplicar a edição agora'],
];

export function HelpDialog() {
  const open = useUi((s) => s.helpOpen);
  const set = useUi((s) => s.set);
  if (!open) return null;
  return (
    <Modal title="Atalhos de teclado" onClose={() => set({ helpOpen: false })}>
      <table className="w-full text-[12.5px]">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k} className="border-b border-slate-50">
              <td className="whitespace-nowrap py-1.5 pr-3">
                <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">{k}</kbd>
              </td>
              <td className="py-1.5 text-slate-600">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 space-y-1 text-[11.5px] text-slate-500">
        <p>
          <b>Linha sólida + pé-de-galinha</b> = FK real. <b className="text-purple-600">Tracejada roxa</b> = relação somente de nota. <b className="text-indigo-600">Pontilhada</b> = N:N via
          pivot oculto.
        </p>
        <p>Relações-nota e tags ficam salvas nos textos como comentários <code>@erd:ref</code> / <code>@erd:tags</code>.</p>
      </div>
    </Modal>
  );
}

const ORIGIN_LABEL: Record<string, string> = { canvas: 'canvas', history: 'desfazer/refazer', load: 'carregamento', inspector: 'inspetor' };

export function ChangeToast() {
  const report = useProjectStore((s) => s.report);
  const dismiss = useProjectStore((s) => s.dismissReport);
  const toast = useUi((s) => s.toast);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;

  useEffect(() => {
    setExpanded(false);
    if (!report) return;
    const t = setTimeout(() => {
      if (!expandedRef.current) dismiss();
    }, 6000);
    return () => clearTimeout(t);
  }, [report, dismiss]);

  const fromText = report && ['sql', 'prisma', 'drizzle'].includes(report.origin);
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-30 flex flex-col items-start gap-2">
      {toast && <div className="pointer-events-auto rounded-lg bg-slate-800 px-3 py-2 text-[12px] text-white shadow-lg">{toast}</div>}
      {report && fromText && (
        <div className="pointer-events-auto w-80 rounded-lg border border-slate-200 bg-white text-[12px] shadow-lg">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="font-medium text-slate-700">
              {report.items.length} mudança(s) aplicada(s) via {FORMAT_LABEL[report.origin as Format] ?? ORIGIN_LABEL[report.origin]}
            </span>
            <button className="ml-auto text-slate-400 hover:text-slate-700" onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            <button className="text-slate-400 hover:text-slate-700" onClick={dismiss}>
              <X size={14} />
            </button>
          </div>
          {expanded && (
            <ul className="max-h-48 overflow-y-auto border-t border-slate-100 px-3 py-2 text-slate-600">
              {report.items.map((c, i) => (
                <li key={i}>• {c}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
