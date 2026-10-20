import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Crosshair, Download, PencilLine, Wand2, XCircle } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import type { Format, Project, Table } from '@erd/model/types';
import { FORMATS, FORMAT_LABEL } from '@erd/model/types';
import { codeText } from '@erd/crdt';
import { GENERATORS, readSync, resolveRange } from '@erd/sync';
import type { Id } from '@erd/model/types';
import { setPresence, useDirectory, usePresence } from '../collab/presence';
import type { EditorMark } from '../editors/CodeEditor';
import { CodeEditor, type CodeEditorHandle } from '../editors/CodeEditor';
import { LANGUAGES } from '../editors/languages';
import { usePanels } from '../sync/panels';
import { useUi, showToast } from '../store/useUi';
import { useProjectStore } from '../store/useProjectStore';
import { getSession } from '../collab/session';
import { useSession } from '../collab/useSession';
import { saveBlob } from '../persistence/files';
import { slugify, qi } from '@erd/model/naming';
import { tableById } from '@erd/model/schema';
import { computePrismaNames } from '@erd/model/formats/prisma/mapping';
import { computeDrizzleNames } from '@erd/model/formats/drizzle/generate';

const EXT: Record<Format, string> = { sql: 'sql', prisma: 'prisma', drizzle: 'ts' };

/** Trecho que marca o início da definição da tabela em cada formato, pra localizar no texto */
function tableAnchor(format: Format, table: Table, doc: Pick<Project, 'schema' | 'meta'>): string {
  if (format === 'sql') return `CREATE TABLE ${(table.schema ? qi(table.schema) + '.' : '') + qi(table.name)}`;
  if (format === 'prisma') return `model ${computePrismaNames(doc).model.get(table.id) ?? table.name} {`;
  return `export const ${computeDrizzleNames(doc).table.get(table.id) ?? table.name} = `;
}

function StatusBadge({ f }: { f: Format }) {
  const p = usePanels((s) => s.panels[f]);
  const errors = p.diagnostics.filter((d) => d.severity === 'error').length;
  const warns = p.diagnostics.filter((d) => d.severity === 'warning').length;
  if (p.status === 'editing')
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-600">
        <PencilLine size={12} /> editando{errors ? ` · ${errors} erro(s)` : ''}
      </span>
    );
  if (p.status === 'error')
    return (
      <span className="flex items-center gap-1 text-[11px] text-red-600">
        <XCircle size={12} /> {errors} erro(s) — o trecho com erro não altera o modelo
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-600">
      <CheckCircle2 size={12} /> sincronizado{warns ? ` · ${warns} aviso(s)` : ''}
    </span>
  );
}

/** Texto atual de um painel, re-renderizando a cada mudança (para copiar/baixar/localizar) */
function usePanelText(f: Format) {
  const session = useSession();
  const [text, setText] = useState(() => (session ? codeText(session.doc, f).toString() : ''));
  useEffect(() => {
    if (!session) return;
    const t = codeText(session.doc, f);
    const fn = () => setText(t.toString());
    fn();
    t.observe(fn);
    return () => t.unobserve(fn);
  }, [session, f]);
  return text;
}

export function CodePanel() {
  const tab = useUi((s) => s.panelTab);
  const set = useUi((s) => s.set);
  const panel = usePanels((s) => s.panels[tab]);
  const name = useProjectStore((s) => s.name);
  const doc = useProjectStore((s) => s.doc);
  const readOnly = useProjectStore((s) => s.readOnly);
  const jumpToTable = useUi((s) => s.jumpToTable);
  const session = useSession();
  const editor = useRef<CodeEditorHandle>(null);
  const text = usePanelText(tab);

  const onSave = useCallback(() => getSession()?.bot.flush(tab), [tab]);
  const onFormat = useCallback(() => {
    if (readOnly) return;
    const { doc } = useProjectStore.getState();
    editor.current?.replaceAll(GENERATORS[tab](doc));
    getSession()?.bot.clearDivergent(tab);
    showToast('Formatado no padrão canônico (as diretivas @erd: ficam; comentários livres, não)');
  }, [tab, readOnly]);

  const revealOffset = useMemo(() => {
    if (!jumpToTable) return null;
    const t = tableById(doc.schema, jumpToTable.id);
    if (!t) return null;
    const idx = text.indexOf(tableAnchor(tab, t, doc));
    if (idx < 0) {
      showToast('Tabela não encontrada no código atual');
      return null;
    }
    return idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToTable]);

  const showAuthorship = useUi((s) => s.showAuthorship);
  const peerNodes = usePresence((s) => s.nodes);
  const people = useDirectory((s) => s.people);
  const me = useDirectory((s) => s.me);

  // source map (§5.4): blocos do texto atual e as entidades que cada um define, do último parse do bot
  const blocks = useMemo(() => {
    if (!session) return [];
    const out: { from: number; to: number; ids: Id[] }[] = [];
    for (const b of readSync(session.doc, tab)?.blocks ?? []) {
      const r = resolveRange(session.doc, b);
      if (r) out.push({ ...r, ids: b.ids });
    }
    return out;
    // o texto e o estado do bot mudam juntos com `text`/`panel`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tab, text, panel]);

  // em qual aba esta pessoa está (bolinhas no seletor de abas dos outros)
  useEffect(() => {
    setPresence(session, { panel: { format: tab } });
    return () => setPresence(getSession(), { panel: null });
  }, [session, tab]);

  const [cursorEntity, setCursorEntity] = useState<Id | null>(null);
  const onCursor = useCallback(
    (offset: number | null) => {
      const b = offset === null ? undefined : blocks.find((x) => offset >= x.from && offset <= x.to);
      setPresence(getSession(), { panel: { format: tab, entityId: b?.ids[0] } });
      if (offset !== null) setCursorEntity(b?.ids[0] ?? null);
    },
    [blocks, tab],
  );
  // ponte painel → canvas: centraliza e seleciona a tabela em que o cursor está
  const rf = useReactFlow();
  const revealInCanvas = () => {
    if (!cursorEntity || !rf.getNode(cursorEntity)) return showToast('Essa entidade não está visível no diagrama');
    set({ selectionRequest: { nodes: [cursorEntity], edges: [], nonce: Date.now() }, selectedNodes: [cursorEntity], selectedEdges: [] });
    void rf.fitView({ nodes: [{ id: cursorEntity }], padding: 0.5, duration: 400, maxZoom: 1.2 });
  };

  const marks = useMemo(() => {
    const out: EditorMark[] = panel.divergent.map((d) => ({ from: d.from, to: d.to, className: 'erd-divergent' }));
    // faixa na margem na cor de quem está com a tabela selecionada no canvas
    for (const b of blocks) {
      const who = b.ids.map((id) => peerNodes.get(id)?.selectedBy[0]).find(Boolean);
      if (who) out.push({ from: b.from, to: b.to, className: 'erd-peer-block', color: who.color });
    }
    return out;
  }, [panel.divergent, blocks, peerNodes]);

  // erros com dono (§5.4): o erro de um trecho que outra pessoa está escrevendo aparece como "em edição por Fulana"
  const diagnostics = useMemo(
    () =>
      panel.diagnostics.map((d) => {
        if (!d.author || d.author === me || d.severity !== 'error') return d;
        return { ...d, severity: 'info' as const, message: `Em edição por ${people.get(d.author)?.name ?? 'outra pessoa'}: ${d.message}` };
      }),
    [panel.diagnostics, people, me],
  );

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
            <TabPeers f={f} />
            <TabDot f={f} />
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <StatusBadge f={tab} />
        <div className="ml-auto flex items-center gap-0.5">
          {cursorEntity && (
            <button title="Ver no diagrama a tabela onde está o cursor" className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-indigo-600 hover:bg-indigo-50" onClick={revealInCanvas} data-testid="reveal-in-canvas">
              <Crosshair size={13} /> Ver no diagrama
            </button>
          )}
          {!readOnly && (
            <button
              title="Formatar no padrão canônico (Shift+Alt+F) — apaga a formatação própria e os comentários livres"
              className="rounded p-1 text-slate-500 hover:bg-slate-100"
              onClick={onFormat}
            >
              <Wand2 size={14} />
            </button>
          )}
          <button
            title="Copiar"
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              showToast('Copiado');
            }}
          >
            <Copy size={14} />
          </button>
          <button
            title={`Baixar schema.${EXT[tab]}`}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            onClick={() => void saveBlob(new Blob([text], { type: 'text/plain' }), `${slugify(name)}.${tab === 'drizzle' ? 'schema.ts' : EXT[tab]}`, FORMAT_LABEL[tab])}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      {panel.divergent.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800" data-testid="divergent">
          <AlertTriangle size={14} />
          <span className="flex-1">
            {lineOf(text, d.from)}: {d.message}
          </span>
          {!readOnly && (
            <>
              <button className="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-700" onClick={() => getSession()?.bot.resolve(tab, d.id, 'text')}>
                Usar o texto
              </button>
              <button className="rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100" onClick={() => getSession()?.bot.resolve(tab, d.id, 'diagram')}>
                Usar o diagrama
              </button>
            </>
          )}
        </div>
      ))}
      {session && (
        <CodeEditor
          key={tab}
          ref={editor}
          className="min-h-0 flex-1 overflow-hidden"
          ytext={codeText(session.doc, tab)}
          awareness={session.awareness}
          language={LANGUAGES[tab]}
          diagnostics={diagnostics}
          marks={marks}
          authorship={showAuthorship}
          onCursor={onCursor}
          readOnly={readOnly}
          onSave={onSave}
          onBlur={onSave}
          onFormat={onFormat}
          revealOffset={revealOffset}
          revealToken={jumpToTable?.nonce}
        />
      )}
      {diagnostics.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11.5px]" data-testid="diagnostics">
          {diagnostics.map((d, i) => (
            <div key={i} className={d.severity === 'error' ? 'text-red-700' : d.severity === 'warning' ? 'text-amber-700' : 'text-slate-500'}>
              {d.severity === 'error' ? '✖' : d.severity === 'warning' ? '⚠' : 'ℹ'} {lineOf(text, d.from)}: {d.message}
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

/** Quem está em cada aba (bolinhas na cor de cada pessoa) */
function TabPeers({ f }: { f: Format }) {
  const peers = usePresence((s) => s.panels.get(f));
  if (!peers?.length) return null;
  return (
    <span className="ml-1.5 inline-flex -space-x-0.5 align-middle" data-testid={`tab-peers-${f}`}>
      {peers.slice(0, 4).map((p) => (
        <span key={p.clientId} title={p.name} className="inline-block h-2 w-2 rounded-full ring-1 ring-white" style={{ background: p.color }} />
      ))}
    </span>
  );
}

function TabDot({ f }: { f: Format }) {
  const p = usePanels((s) => s.panels[f]);
  if (p.status === 'error') return <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500" />;
  if (p.divergent.length || p.status === 'editing') return <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />;
  return null;
}

function lineOf(text: string, offset: number) {
  let line = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text[i] === '\n') line++;
  return `linha ${line}`;
}
