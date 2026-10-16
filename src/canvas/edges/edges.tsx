import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';

/** Extremidades de cardinalidade (notação pé-de-galinha) */
export type EndMark = 'one' | 'zero-one' | 'many' | 'zero-many' | 'one-many' | 'none';

export type ErdEdgeData = {
  start: EndMark;
  end: EndMark;
  label?: string;
  detail?: string;
  variant: 'fk' | 'note' | 'nn' | 'enum';
  /** Só para relações-nota: mostra também o nome no sentido contrário */
  showReverse?: boolean;
  reverseLabel?: string;
  cardinality?: string;
  reverseCardinality?: string;
  cardinalityStyle?: 'look-across' | 'below-label';
  offset?: number;
  labelOffset?: number;
  /** Relação ligada diretamente à tabela selecionada no canvas — destaca sem marcar como `selected` */
  emphasized?: boolean;
  /** Não toca a tabela selecionada nem suas relações diretas — apaga */
  dimmed?: boolean;
};
export type ErdEdge = Edge<ErdEdgeData, 'erd'>;

export const COLORS = {
  fk: '#64748b',
  note: '#a855f7',
  nn: '#6366f1',
  enum: '#10b981',
  selected: '#4f46e5',
};

export type ColorKey = keyof typeof COLORS;

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
  const emphasized = selected || !!data?.emphasized;
  const dimmed = !emphasized && !!data?.dimmed;
  // relação destacada (selecionada ou ligada diretamente à tabela selecionada) usa a mesma cor roxa
  const colorKey: ColorKey = emphasized ? 'selected' : variant;
  const self = source === target;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (self) {
    // auto-relação: laço pelo lado direito
    const dx = 48 + (data?.offset ?? 0);
    path = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY}, ${targetX + dx} ${targetY}, ${targetX} ${targetY}`;
    labelX = sourceX + dx * 0.8;
    labelY = (sourceY + targetY) / 2;
  } else {
    // relações paralelas entre o mesmo par de tabelas recebem um deslocamento real do
    // ponto de curvatura (centerX/centerY), não só do trecho inicial — senão os trajetos
    // continuam coincidindo no meio do caminho mesmo com `offset` diferente
    const centerShift = data?.offset ?? 0;
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 10,
      offset: 24,
      ...(centerShift
        ? { centerX: (sourceX + targetX) / 2 + centerShift, centerY: (sourceY + targetY) / 2 + centerShift }
        : {}),
    });
  }
  labelY += data?.labelOffset ?? 0;
  const dash = variant === 'note' ? '7 5' : variant === 'nn' ? '2 4' : variant === 'enum' ? '3 3' : undefined;
  const showLabel = data?.label && (variant !== 'fk' || emphasized);
  const showReverseLabel = variant === 'note' && data?.showReverse && data?.reverseLabel;
  // ponto do rótulo reverso: entre a origem e o rótulo principal, do lado da origem
  const reverseX = sourceX + (labelX - sourceX) * 0.45;
  const reverseY = sourceY + (labelY - sourceY) * 0.45;

  const isBelowLabel = variant === 'note' && data?.cardinalityStyle === 'below-label';
  const isLookAcross = variant === 'note' && (data?.cardinalityStyle ?? 'look-across') === 'look-across';

  return (
    <>
      {emphasized && (
        // halo por baixo: destaca a relação entre as outras arestas sem elevar seu z-index
        // acima dos nós (arestas sempre ficam atrás das tabelas — ver nota em Canvas.tsx)
        <path d={path} fill="none" stroke="#fff" strokeWidth={5.5} strokeOpacity={0.9} />
      )}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        markerStart={data?.start && data.start !== 'none' ? `url(#${markerId(data.start, colorKey)})` : undefined}
        markerEnd={data?.end && data.end !== 'none' ? `url(#${markerId(data.end, colorKey)})` : undefined}
        style={{
          stroke: COLORS[colorKey],
          strokeWidth: emphasized ? 2.2 : 1.5,
          strokeDasharray: dash,
          opacity: dimmed ? 0.3 : variant === 'enum' && !emphasized ? 0.65 : 1,
          transition: 'opacity 0.15s, stroke 0.15s',
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={
              'nodrag nopan pointer-events-auto absolute rounded-full border px-2.5 py-0.5 text-[10.5px] shadow-sm ' +
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
            <div className="text-center">
              <div>{data?.label}</div>
              {isBelowLabel && data?.cardinality && (
                <div className="text-[9px] font-semibold text-purple-600/90 leading-tight">
                  {data.cardinality}
                </div>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
      {showReverseLabel && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute rounded-full border border-purple-200 bg-purple-50/90 px-2.5 py-0.5 text-[10.5px] text-purple-700 shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${reverseX}px, ${reverseY}px)` }}
            data-edge-id={id}
            title="Nome da relação no sentido contrário"
          >
            <div className="text-center">
              <div>↩ {data?.reverseLabel}</div>
              {isBelowLabel && data?.reverseCardinality && (
                <div className="text-[9px] font-semibold text-purple-600/90 leading-tight">
                  {data.reverseCardinality}
                </div>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
      {isLookAcross && data?.cardinality && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded border border-purple-200 bg-purple-100/95 px-1 py-0.2 text-[9px] font-bold text-purple-800 shadow-xs"
            style={{
              transform: `translate(-50%, -100%) translate(${targetX + (targetPosition === 'left' ? -18 : 18)}px, ${
                targetY - 5 + (data?.labelOffset ? (data.labelOffset > 0 ? 14 : -14) : 0)
              }px)`,
            }}
            title={`Cardinalidade (A → B): ${data.cardinality}`}
          >
            {data.cardinality}
          </div>
        </EdgeLabelRenderer>
      )}
      {isLookAcross && data?.showReverse && data?.reverseCardinality && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded border border-purple-200 bg-purple-100/95 px-1 py-0.2 text-[9px] font-bold text-purple-800 shadow-xs"
            style={{
              transform: `translate(-50%, -100%) translate(${sourceX + (sourcePosition === 'left' ? -18 : 18)}px, ${
                sourceY - 5 + (data?.labelOffset ? (data.labelOffset > 0 ? 14 : -14) : 0)
              }px)`,
            }}
            title={`Cardinalidade reversa (B → A): ${data.reverseCardinality}`}
          >
            {data.reverseCardinality}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const ErdEdgeComponent = memo(ErdEdgeImpl);
