import { memo, useEffect, useRef, useState } from 'react';
import { Handle, NodeResizeControl, Position, type NodeProps, type Node } from '@xyflow/react';
import { KeyRound, Link2, Plus } from 'lucide-react';
import type { Column, Table } from '@erd/model/types';
import { formatType, parseTypeString, COMMON_TYPES } from '@erd/model/columnType';
import { addColumn, resizeNode, updateTable } from '../../store/actions';
import { useUi, revealTableInCode } from '../../store/useUi';
import { useProjectStore } from '../../store/useProjectStore';
import { NodeDecor, useColumnDecor } from '../../collab/presence/NodeDecor';

export type TableNodeData = {
  table: Table;
  fkCols: string[];
  tags: string[];
  relationTarget: boolean;
};
export type TableFlowNode = Node<TableNodeData, 'table'>;

const TAG_COLOR: Record<string, string> = {
  pivot: 'bg-amber-100 text-amber-800 border-amber-200',
  history: 'bg-sky-100 text-sky-800 border-sky-200',
};

function InlineInput({ value, onDone, className, list }: { value: string; onDone: (v: string | null) => void; className?: string; list?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(value);
  useEffect(() => {
    // o React Flow mantém nós novos invisíveis até medi-los: tenta focar por alguns frames
    let frames = 0;
    let raf = 0;
    const tryFocus = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (document.activeElement === el) el.select();
      else if (frames++ < 30) raf = requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <input
      ref={ref}
      list={list}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v);
        if (e.key === 'Escape') onDone(null);
      }}
      className={'nodrag nopan nowheel rounded border border-indigo-400 bg-white px-1 outline-none ' + (className ?? '')}
    />
  );
}

function ColumnRow({ table, col, isFk }: { table: Table; col: Column; isFk: boolean }) {
  const editing = useUi((s) => s.editing);
  const isPk = table.primaryKey.includes(col.id);
  const edit = editing?.kind === 'column' && editing.colId === col.id;
  const [field, setField] = useState<'name' | 'type'>('name');
  const done = () => useUi.getState().set({ editing: null });
  const decor = useColumnDecor(table.id, col.id);

  return (
    <div
      className="group/col relative flex h-[26px] items-center gap-1.5 px-2.5 text-[12px] hover:bg-slate-50"
      style={decor.style}
      title={decor.title}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setField((e.target as HTMLElement).dataset.field === 'type' ? 'type' : 'name');
        useUi.getState().set({ editing: { kind: 'column', id: table.id, colId: col.id } });
      }}
    >
      <Handle type="source" id={`${col.id}-L`} position={Position.Left} className="erd-handle" />
      <span className="flex w-4 shrink-0 justify-center">
        {isPk ? <KeyRound size={12} className="text-amber-500" /> : isFk ? <Link2 size={12} className="text-indigo-500" /> : null}
      </span>
      {edit && field === 'name' ? (
        <InlineInput
          value={col.name}
          className="w-28 text-[12px]"
          onDone={(v) => {
            if (v && v.trim() && v !== col.name)
              updateTable(table.id, (t) => {
                const c = t.columns.find((x) => x.id === col.id);
                if (c) c.name = v.trim();
              });
            done();
          }}
        />
      ) : (
        <span data-field="name" className={'min-w-0 flex-1 truncate ' + (isPk ? 'font-semibold' : '')}>
          {col.name}
        </span>
      )}
      {edit && field === 'type' ? (
        <InlineInput
          value={formatType(col.type)}
          list="erd-types"
          className="w-28 font-mono text-[11px]"
          onDone={(v) => {
            if (v && v.trim())
              updateTable(table.id, (t) => {
                const c = t.columns.find((x) => x.id === col.id);
                if (c) c.type = parseTypeString(v);
              });
            done();
          }}
        />
      ) : (
        <span data-field="type" className="ml-auto truncate font-mono text-[11px] text-slate-500">
          {formatType(col.type)}
          {col.nullable && !isPk ? <span className="text-slate-400">?</span> : null}
        </span>
      )}
      {col.unique && !isPk ? <span className="rounded bg-slate-100 px-1 text-[9px] font-semibold text-slate-500">UQ</span> : null}
      <Handle type="source" id={`${col.id}-R`} position={Position.Right} className="erd-handle" />
    </div>
  );
}

function TableNodeImpl({ id, data, selected }: NodeProps<TableFlowNode>) {
  const { table, fkCols, tags, relationTarget } = data;
  const editing = useUi((s) => s.editing);
  const readOnly = useProjectStore((s) => s.readOnly);
  const editName = editing?.kind === 'table-name' && editing.id === id;
  const fk = new Set(fkCols);

  return (
    <div
      className={
        'erd-table rounded-lg border bg-white shadow-sm transition-shadow ' +
        (selected ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-slate-300') +
        (relationTarget ? ' ring-2 ring-emerald-300' : '')
      }
      style={{ width: '100%' }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        revealTableInCode(table.id);
      }}
    >
      <NodeDecor id={id} />
      {/* fora do cabeçalho (que tem `relative`) para ancorar no topo/base do card inteiro, não só do cabeçalho */}
      <Handle type="source" id={`${id}-hT`} position={Position.Top} className="erd-handle erd-handle-head" title="Relação-nota (topo)" />
      {selected && !readOnly && (
        <NodeResizeControl
          minWidth={180}
          position="right"
          style={{ background: 'transparent', border: 'none', width: 8, height: '100%', top: 0, right: -4, transform: 'none', cursor: 'ew-resize' }}
          onResizeEnd={(_e, p) => resizeNode(id, p.width)}
        />
      )}
      <div className="relative flex h-[38px] items-center gap-2 rounded-t-lg border-b border-slate-200 bg-slate-50 px-2.5">
        <Handle type="source" id={`${id}-hL`} position={Position.Left} className="erd-handle erd-handle-head" />
        {editName ? (
          <InlineInput
            value={table.name}
            className="w-full text-[13px] font-semibold"
            onDone={(v) => {
              if (v && v.trim() && v !== table.name) updateTable(id, (t) => void (t.name = v.trim()), 'Tabela renomeada');
              useUi.getState().set({ editing: null });
            }}
          />
        ) : (
          <span
            className="min-w-0 truncate text-[13px] font-semibold text-slate-800"
            onDoubleClick={(e) => {
              e.stopPropagation();
              useUi.getState().set({ editing: { kind: 'table-name', id } });
            }}
          >
            {table.schema ? <span className="font-normal text-slate-400">{table.schema}.</span> : null}
            {table.name}
          </span>
        )}
        <div className="ml-auto flex shrink-0 gap-1">
          {tags.map((t) => (
            <span key={t} className={'rounded border px-1 text-[9px] font-medium uppercase ' + (TAG_COLOR[t] ?? 'border-violet-200 bg-violet-100 text-violet-800')}>
              {t}
            </span>
          ))}
        </div>
        <Handle type="source" id={`${id}-hR`} position={Position.Right} className="erd-handle erd-handle-head" />
      </div>
      <div className="py-1">
        {table.columns.map((c) => (
          <ColumnRow key={c.id} table={table} col={c} isFk={fk.has(c.id)} />
        ))}
        {table.columns.length === 0 && <div className="px-3 py-1 text-[11px] italic text-slate-400">sem colunas</div>}
      </div>
      {selected && !readOnly && (
        <button
          className="erd-export-hide nodrag flex w-full items-center justify-center gap-1 rounded-b-lg border-t border-slate-100 py-1 text-[11px] text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"
          onClick={(e) => {
            e.stopPropagation();
            const colId = addColumn(id);
            useUi.getState().set({ editing: { kind: 'column', id, colId } });
          }}
        >
          <Plus size={12} /> coluna
        </button>
      )}
      <Handle type="source" id={`${id}-hB`} position={Position.Bottom} className="erd-handle erd-handle-head" title="Relação-nota (base)" />
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);

export function TypeDatalist() {
  return (
    <datalist id="erd-types">
      {COMMON_TYPES.map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}
