import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';

/** Extremidades de cardinalidade (notação pé-de-galinha) */
export type EndMark = 'one' | 'zero-one' | 'many' | 'zero-many' | 'one-many' | 'none';

export type ErdEdgeData = {
  start: EndMark;
  end: EndMark;
  label?: string;
  detail?: string;
  variant: 'fk' | 'note' | 'nn';
};
export type ErdEdge = Edge<ErdEdgeData, 'erd'>;

const COLORS = {
  fk: '#64748b',
  note: '#a855f7',
  nn: '#6366f1',
  selected: '#4f46e5',
};

type ColorKey = keyof typeof COLORS;

function markerShape(kind: EndMark, color: string) {
  // desenhado com a ponta da aresta em x=20 (refX), eixo ao longo da aresta
  const s = { stroke: color, strokeWidth: 1.5, fill: 'none' };
  const bar = (x: number) => <line x1={x} y1={4} x2={x} y2={16} {...s} />;
  const circle = (cx: number) => <circle cx={cx} cy={10} r={3.5} {...s} fill="var(--canvas-bg, #fff)" />;
  const crow = (
    <>
      <line x1={9} y1={10} x2={20} y2={3} {...s} />
      <line x1={9} y1={10} x2={20} y2={17} {...s} />
      <line x1={9} y1={10} x2={20} y2={10} {...s} />
    </>
  );
  switch (kind) {
    case 'one':
      return (
        <>
          {bar(11)}
          {bar(15)}
        </>
      );
    case 'zero-one':
      return (
        <>
          {circle(7)}
          {bar(15)}
        </>
      );
    case 'many':
      return crow;
    case 'zero-many':
      return (
        <>
          {crow}
          {circle(4.5)}
        </>
      );
    case 'one-many':
      return (
        <>
          {crow}
          {bar(6)}
        </>
      );
    default:
      return null;
  }
}

const KINDS: EndMark[] = ['one', 'zero-one', 'many', 'zero-many', 'one-many'];

export const markerId = (kind: EndMark, color: ColorKey) => `erd-${kind}-${color}`;

export function ErdMarkers() {
  return (
    <svg id="erd-marker-defs" style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        {(Object.keys(COLORS) as ColorKey[]).flatMap((c) =>
          KINDS.map((k) => (
            <marker
              key={markerId(k, c)}
              id={markerId(k, c)}
              viewBox="0 0 22 20"
              refX={20}
              refY={10}
              markerWidth={22}
              markerHeight={20}
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              {markerShape(k, COLORS[c])}
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}

function ErdEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, source, target }: EdgeProps<ErdEdge>) {
  const variant = data?.variant ?? 'fk';
  const colorKey: ColorKey = selected ? 'selected' : variant;
  const self = source === target;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (self) {
    // auto-relação: laço pelo lado direito
    const dx = 48;
    path = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX + dx} ${targetY}, ${targetX} ${targetY}`;
    labelX = sourceX + dx * 0.8;
    labelY = (sourceY + targetY) / 2;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10, offset: 24 });
  }
  const dash = variant === 'note' ? '7 5' : variant === 'nn' ? '2 4' : undefined;
  const showLabel = data?.label && (variant !== 'fk' || selected);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        markerStart={data?.start && data.start !== 'none' ? `url(#${markerId(data.start, colorKey)})` : undefined}
        markerEnd={data?.end && data.end !== 'none' ? `url(#${markerId(data.end, colorKey)})` : undefined}
        style={{ stroke: COLORS[colorKey], strokeWidth: selected ? 2.2 : 1.5, strokeDasharray: dash }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={
              'nodrag nopan pointer-events-auto absolute rounded-full border px-2 py-0.5 text-[10.5px] shadow-sm ' +
              (variant === 'note'
                ? 'border-purple-200 bg-purple-50 text-purple-700'
                : variant === 'nn'
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600')
            }
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-edge-id={id}
            title={data?.detail}
          >
            {data?.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const ErdEdgeComponent = memo(ErdEdgeImpl);
