import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { EnumType } from '../../model/types';

export type EnumFlowNode = Node<{ enumType: EnumType }, 'enum'>;

function EnumNodeImpl({ data, selected }: NodeProps<EnumFlowNode>) {
  const e = data.enumType;
  return (
    <div className={'rounded-lg border bg-white shadow-sm ' + (selected ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-emerald-300')}>
      <div className="relative flex h-[38px] items-center gap-2 rounded-t-lg border-b border-emerald-200 bg-emerald-50 px-2.5">
        <Handle type="source" id={`${e.id}-hL`} position={Position.Left} className="erd-handle erd-handle-head" />
        <span className="rounded bg-emerald-200 px-1 text-[9px] font-semibold uppercase text-emerald-800">enum</span>
        <span className="truncate text-[13px] font-semibold text-slate-800">{e.name}</span>
        <Handle type="source" id={`${e.id}-hR`} position={Position.Right} className="erd-handle erd-handle-head" />
      </div>
      <div className="py-1">
        {e.values.map((v) => (
          <div key={v} className="h-[22px] px-3 font-mono text-[11px] leading-[22px] text-slate-600">
            {v}
          </div>
        ))}
      </div>
    </div>
  );
}

export const EnumNode = memo(EnumNodeImpl);
