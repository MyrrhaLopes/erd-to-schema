import { useCallback, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Download, Loader2, PencilLine, RefreshCw, XCircle } from 'lucide-react';
import type { Format, Project, Table } from '../model/types';
import { FORMATS, FORMAT_LABEL } from '../model/types';
import { CodeEditor } from '../editors/CodeEditor';
import { LANGUAGES } from '../editors/languages';
import { applyPending, discardLocal, flush, onLocalEdit, regenerate, usePanels } from '../sync/engine';
import { useUi, showToast } from '../store/useUi';
import { useProjectStore } from '../store/useProjectStore';
import { saveBlob } from '../persistence/files';
import { slugify, qi } from '../model/naming';
import { tableById } from '../model/schema';
import { computePrismaNames } from '../formats/prisma/mapping';
import { computeDrizzleNames } from '../formats/drizzle/generate';

const EXT: Record<Format, string> = { sql: 'sql', prisma: 'prisma', drizzle: 'ts' };

/** Trecho que marca o início da definição da tabela em cada formato, pra localizar no texto gerado */
function tableAnchor(format: Format, table: Table, doc: Pick<Project, 'schema' | 'meta'>): string {
  if (format === 'sql') return `CREATE TABLE ${(table.schema ? qi(table.schema) + '.' : '') + qi(table.name)}`;
  if (format === 'prisma') return `model ${computePrismaNames(doc).model.get(table.id) ?? table.name} {`;
  return `export const ${computeDrizzleNames(doc).table.get(table.id) ?? table.name} = `;
}

function StatusBadge({ f }: { f: Format }) {
  const p = usePanels((s) => s.panels[f]);
  const errors = p.diagnostics.filter((d) => d.severity === 'error').length;
  const warns = p.diagnostics.filter((d) => d.severity === 'warning').length;
  if (p.status === 'parsing')
    return (
      <span className="flex items-center gap-1 text-[11px] text-slate-500">
        <Loader2 size={12} className="animate-spin" /> analisando…
      </span>
    );
  if (p.status === 'editing')
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-600">
        <PencilLine size={12} /> editando
      </span>
    );
  if (p.status === 'error')
    return (
      <span className="flex items-center gap-1 text-[11px] text-red-600">
        <XCircle size={12} /> {errors} erro(s) — modelo não alterado
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-600">
      <CheckCircle2 size={12} /> sincronizado{warns ? ` · ${warns} aviso(s)` : ''}
    </span>
  );
}

export function CodePanel() {
  const tab = useUi((s) => s.panelTab);
  const set = useUi((s) => s.set);
  const panel = usePanels((s) => s.panels[tab]);
  const pending = usePanels((s) => s.pending[tab]);
  const name = useProjectStore((s) => s.name);
  const doc = useProjectStore((s) => s.doc);
  const jumpToTable = useUi((s) => s.jumpToTable);

  const onChange = useCallback((text: string) => onLocalEdit(tab, text), [tab]);
  const onSave = useCallback(() => flush(tab), [tab]);

  const revealOffset = useMemo(() => {
    if (!jumpToTable) return null;
    const t = tableById(doc.schema, jumpToTable.id);
    if (!t) return null;
    const idx = panel.text.indexOf(tableAnchor(tab, t, doc));
    if (idx < 0) {
      showToast('Tabela não encontrada no código atual');
      return null;
    }
    return idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToTable, tab, doc, panel.text]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-white">
      <div className="flex items-center gap-1 border-b border-slate-200 px-2 pt-2">
        {FORMATS.map((f) => (
          <button
            key={f}
            onClick={() => set({ panelTab: f })}
            className={
              'relative rounded-t-md border border-b-0 px-3 py-1.5 text-[12px] font-medium ' +
              (tab === f ? 'border-slate-200 bg-white text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-700')
            }
          >
            {FORMAT_LABEL[f]}
            <TabDot f={f} />
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <StatusBadge f={tab} />
        <div className="ml-auto flex items-center gap-0.5">
          <button title="Regenerar no formato canônico (descarta formatação própria)" className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={() => regenerate(tab)}>
            <RefreshCw size={14} />
          </button>
          <button
            title="Copiar"
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            onClick={() => {
              void navigator.clipboard.writeText(panel.text);
              showToast('Copiado');
            }}
          >
            <Copy size={14} />
          </button>
          <button
            title={`Baixar schema.${EXT[tab]}`}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            onClick={() => void saveBlob(new Blob([panel.text], { type: 'text/plain' }), `${slugify(name)}.${tab === 'drizzle' ? 'schema.ts' : EXT[tab]}`, FORMAT_LABEL[tab])}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      {panel.conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertTriangle size={14} />
          <span className="flex-1">O modelo mudou em outra vista enquanto você editava este painel.</span>
          <button className="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-700" onClick={() => applyPending(tab)} disabled={panel.status === 'error'}>
            {pending ? 'Aplicar minha versão' : 'Aplicar quando válido'}
          </button>
          <button className="rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100" onClick={() => discardLocal(tab)}>
            Recarregar do modelo
          </button>
        </div>
      )}
      <CodeEditor
        key={tab}
        className="min-h-0 flex-1 overflow-hidden"
        value={panel.text}
        language={LANGUAGES[tab]}
        diagnostics={panel.diagnostics}
        onChange={onChange}
        onSave={onSave}
        onBlur={onSave}
        revealOffset={revealOffset}
        revealToken={jumpToTable?.nonce}
      />
      {panel.diagnostics.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11.5px]">
          {panel.diagnostics.map((d, i) => (
            <div key={i} className={d.severity === 'error' ? 'text-red-700' : d.severity === 'warning' ? 'text-amber-700' : 'text-slate-500'}>
              {d.severity === 'error' ? '✖' : d.severity === 'warning' ? '⚠' : 'ℹ'} {lineOf(panel.text, d.from)}: {d.message}
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-slate-100 px-3 py-1 text-[10.5px] text-slate-400">
        Edite qualquer vista: o canvas e as outras duas se atualizam. Ctrl+S aplica na hora. Conceitos só do canvas ficam em comentários <code>@erd:</code>.
      </div>
    </div>
  );
}

function TabDot({ f }: { f: Format }) {
  const p = usePanels((s) => s.panels[f]);
  if (p.status === 'error') return <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500" />;
  if (p.conflict || p.status === 'editing') return <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />;
  return null;
}

function lineOf(text: string, offset: number) {
  let line = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text[i] === '\n') line++;
  return `linha ${line}`;
}
