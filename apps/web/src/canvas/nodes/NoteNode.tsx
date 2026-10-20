import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download } from 'lucide-react';
import type { NoteBlock } from '@erd/model/types';
import { resizeNode, updateNote } from '../../store/actions';
import { useUi } from '../../store/useUi';
import { downloadNote } from '../../persistence/notes';
import * as Y from 'yjs';
import { roots } from '@erd/crdt';
import { useSession } from '../../collab/useSession';
import { CodeEditor } from '../../editors/CodeEditor';
import { LANGUAGES } from '../../editors/languages';
import { NodeDecor } from '../../collab/presence/NodeDecor';

export type NoteFlowNode = Node<{ note: NoteBlock }, 'note'>;

export const NOTE_COLORS: Record<string, { bg: string; border: string; head: string }> = {
  yellow: { bg: '#fffbeb', border: '#fcd34d', head: '#fef3c7' },
  blue: { bg: '#eff6ff', border: '#93c5fd', head: '#dbeafe' },
  green: { bg: '#f0fdf4', border: '#86efac', head: '#dcfce7' },
  pink: { bg: '#fdf2f8', border: '#f9a8d4', head: '#fce7f3' },
  gray: { bg: '#f8fafc', border: '#cbd5e1', head: '#f1f5f9' },
};

const TASK_LINE_RE = /^(\s*[-*+]\s+)\[([ xX])\]/;

/**
 * Linha (0-based) do item de tarefa markdown em que o checkbox atual está, lida da posição
 * do `<li>` ancestral no texto-fonte. Não usamos um contador de ordem de renderização porque o
 * StrictMode do React invoca os componentes de `react-markdown` duas vezes, o que desalinharia
 * qualquer contador compartilhado e trocaria a linha alternada pela errada.
 */
const TaskLineContext = createContext<number | undefined>(undefined);

/** Alterna o estado `[ ]`/`[x]` de uma linha (0-based) de lista de tarefas markdown */
function toggleTaskLine(content: string, line: number): string {
  const lines = content.split('\n');
  const l = lines[line];
  const m = l == null ? null : l.match(TASK_LINE_RE);
  if (!m) return content;
  lines[line] = l.replace(TASK_LINE_RE, `$1[${m[2] === ' ' ? 'x' : ' '}]`);
  return lines.join('\n');
}

function NoteNodeImpl({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note } = data;
  const editing = useUi((s) => s.editing?.kind === 'note' && s.editing.id === id);
  const [draft, setDraft] = useState(note.content);
  const [title, setTitle] = useState(note.title);
  const ta = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const c = NOTE_COLORS[note.color ?? 'yellow'] ?? NOTE_COLORS.yellow;
  const session = useSession();
  const showAuthorship = useUi((s) => s.showAuthorship);
  // o conteúdo da nota é um Y.Text: editado direto pelo y-codemirror, com cursores e rastro dos outros (§5.3)
  const ytext = useMemo(() => {
    const t = session ? roots(session.doc).notes.get(id)?.get('content') : undefined;
    return t instanceof Y.Text ? t : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, id, editing]);

  useEffect(() => {
    if (editing) {
      setDraft(note.content);
      setTitle(note.title);
      setTimeout(() => (ta.current ?? rootRef.current?.querySelector<HTMLElement>('.cm-content'))?.focus(), 0);
    }
    // só ao entrar em modo de edição
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // expande o bloco automaticamente quando o conteúdo renderizado não cabe (nunca encolhe sozinho)
  // usa offsetWidth/offsetHeight (caixa de layout) em vez de getBoundingClientRect, que retorna
  // o tamanho já escalado pelo zoom do canvas do React Flow e corromperia a largura salva
  useEffect(() => {
    if (editing) return;
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const needed = Math.ceil(content.scrollHeight) + 32 + 2;
    const current = root.offsetHeight;
    if (needed > current + 1) {
      resizeNode(id, root.offsetWidth, needed);
    }
  }, [id, note.content, editing]);

  const finish = () => {
    if (ytext) {
      if (title !== note.title) updateNote(id, (n) => void (n.title = title.trim() || 'Nota'));
      useUi.getState().set({ editing: null });
      return;
    }
    if (draft !== note.content || title !== note.title)
      updateNote(id, (n) => {
        n.content = draft;
        n.title = title.trim() || 'Nota';
      });
    useUi.getState().set({ editing: null });
  };

  const toggleCheckbox = (line: number) => {
    updateNote(id, (n) => {
      n.content = toggleTaskLine(n.content, line);
    });
  };

  // memoizado por conteúdo: evita que re-renders do node (ex.: clicar no próprio checkbox
  // seleciona o node) recriem a árvore do Markdown no meio do clique e troquem o <input> sob o cursor
  const markdownView = useMemo(
    () => (
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          li: ({ node, children, ...props }) => {
            const line = node?.position?.start.line;
            return (
              <TaskLineContext.Provider value={line != null ? line - 1 : undefined}>
                <li {...props}>{children}</li>
              </TaskLineContext.Provider>
            );
          },
          input: (props) => {
            const line = useContext(TaskLineContext);
            if (props.type !== 'checkbox') return <input {...props} />;
            return (
              <input
                {...props}
                disabled={false}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  if (line != null) toggleCheckbox(line);
                }}
                className="nodrag mr-1 accent-indigo-600"
              />
            );
          },
        }}
      >
        {note.content}
      </Markdown>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.content],
  );

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      finish();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = el;
      if (e.shiftKey) {
        const lineStart = draft.lastIndexOf('\n', s - 1) + 1;
        const removable = draft.slice(lineStart, lineStart + 2) === '  ' ? 2 : draft.slice(lineStart, lineStart + 1) === '\t' ? 1 : 0;
        if (!removable) return;
        const next = draft.slice(0, lineStart) + draft.slice(lineStart + removable);
        setDraft(next);
        requestAnimationFrame(() => el.setSelectionRange(Math.max(lineStart, s - removable), Math.max(lineStart, en - removable)));
      } else {
        const next = draft.slice(0, s) + '  ' + draft.slice(en);
        setDraft(next);
        requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
      }
    }
  };

  return (
    <>
    <NodeDecor id={id} radius={8} />
    <div
      ref={rootRef}
      className={'erd-note flex h-full w-full flex-col overflow-hidden rounded-lg border shadow-sm ' + (selected ? 'ring-2 ring-indigo-200' : '')}
      style={{ background: c.bg, borderColor: selected ? '#6366f1' : c.border }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!editing) useUi.getState().set({ editing: { kind: 'note', id } });
      }}
    >
      <NodeResizer isVisible={selected} minWidth={160} minHeight={90} onResizeEnd={(_e, p) => resizeNode(id, p.width, p.height)} />
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2.5" style={{ background: c.head, borderColor: c.border }}>
        {editing ? (
          <input
            className="nodrag nopan w-full bg-transparent text-[12px] font-semibold outline-none"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={() =>
              setTimeout(() => {
                if (ytext && !rootRef.current?.contains(document.activeElement)) finish();
              }, 0)
            }
          />
        ) : (
          <span className="truncate text-[12px] font-semibold text-slate-700">📝 {note.title}</span>
        )}
        <button
          title="Exportar .md"
          className="nodrag ml-auto text-slate-400 hover:text-slate-700"
          onClick={(e) => {
            e.stopPropagation();
            downloadNote(note);
          }}
        >
          <Download size={13} />
        </button>
      </div>
      {editing && ytext ? (
        <div
          className="nodrag nopan nowheel min-h-0 flex-1 overflow-auto"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <CodeEditor
            ytext={ytext}
            awareness={session?.awareness}
            language={LANGUAGES.markdown}
            minimal
            authorship={showAuthorship}
            className="h-full [&_.cm-editor]:bg-transparent"
            onExit={finish}
            onBlur={() =>
              setTimeout(() => {
                if (!rootRef.current?.contains(document.activeElement)) finish();
              }, 0)
            }
          />
        </div>
      ) : editing ? (
        <textarea
          ref={ta}
          className="nodrag nopan nowheel h-full w-full flex-1 resize-none bg-transparent p-2.5 font-mono text-[12px] outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={finish}
          onKeyDown={handleEditorKeyDown}
        />
      ) : (
        <div ref={contentRef} className="erd-markdown nowheel flex-1 overflow-auto p-2.5 text-[12px] text-slate-700">
          {markdownView}
        </div>
      )}
    </div>
    </>
  );
}

export const NoteNode = memo(NoteNodeImpl);
