import { memo, useEffect, useRef, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download } from 'lucide-react';
import type { NoteBlock } from '../../model/types';
import { resizeNode, updateNote } from '../../store/actions';
import { useUi } from '../../store/useUi';
import { downloadNote } from '../../persistence/notes';

export type NoteFlowNode = Node<{ note: NoteBlock }, 'note'>;

export const NOTE_COLORS: Record<string, { bg: string; border: string; head: string }> = {
  yellow: { bg: '#fffbeb', border: '#fcd34d', head: '#fef3c7' },
  blue: { bg: '#eff6ff', border: '#93c5fd', head: '#dbeafe' },
  green: { bg: '#f0fdf4', border: '#86efac', head: '#dcfce7' },
  pink: { bg: '#fdf2f8', border: '#f9a8d4', head: '#fce7f3' },
  gray: { bg: '#f8fafc', border: '#cbd5e1', head: '#f1f5f9' },
};

function NoteNodeImpl({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const { note } = data;
  const editing = useUi((s) => s.editing?.kind === 'note' && s.editing.id === id);
  const [draft, setDraft] = useState(note.content);
  const [title, setTitle] = useState(note.title);
  const ta = useRef<HTMLTextAreaElement>(null);
  const c = NOTE_COLORS[note.color ?? 'yellow'] ?? NOTE_COLORS.yellow;

  useEffect(() => {
    if (editing) {
      setDraft(note.content);
      setTitle(note.title);
      setTimeout(() => ta.current?.focus(), 0);
    }
    // só ao entrar em modo de edição
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const finish = () => {
    if (draft !== note.content || title !== note.title)
      updateNote(id, (n) => {
        n.content = draft;
        n.title = title.trim() || 'Nota';
      });
    useUi.getState().set({ editing: null });
  };

  return (
    <div
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
      {editing ? (
        <textarea
          ref={ta}
          className="nodrag nopan nowheel h-full w-full flex-1 resize-none bg-transparent p-2.5 font-mono text-[12px] outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) finish();
          }}
        />
      ) : (
        <div className="erd-markdown nowheel flex-1 overflow-auto p-2.5 text-[12px] text-slate-700">
          <Markdown remarkPlugins={[remarkGfm]}>{note.content}</Markdown>
        </div>
      )}
    </div>
  );
}

export const NoteNode = memo(NoteNodeImpl);
