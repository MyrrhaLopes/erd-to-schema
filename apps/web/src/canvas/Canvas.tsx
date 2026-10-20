import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { FileText, Link2, Table2, X } from 'lucide-react';
import type { Id, Project, SchemaModel } from '@erd/model/types';
import { useProjectStore, undo, redo } from '../store/useProjectStore';
import { useUi } from '../store/useUi';
import {
  connectTables,
  createNote,
  createPivot,
  createRelatedTable,
  createTable,
  deleteElements,
  duplicateTables,
  moveNodes,
  type ConnectResult,
  type Direction,
} from '../store/actions';
import { deriveEdges, deriveNodes } from './derive';
import { TypeDatalist } from './nodes/TableNode';
import { ErdMarkers, type ErdEdge } from './edges/edges';
import { erdKind } from '../kinds/erd';
import { Legend } from './Legend';
import { isTypingTarget } from './keyboard';
import { tableById } from '@erd/model/schema';
import { setPresence, throttle, usePresence } from '../collab/presence';
import { getSession } from '../collab/session';

// nós, arestas, toolbar e inspector vêm do tipo de canvas (§8.3)
const { nodeTypes, edgeTypes, Toolbar, Inspector } = erdKind;

const TOOL_KEYS: Record<string, ReturnType<typeof useProjectStore.getState>['tool']> = {
  v: 'select',
  '1': 'select',
  h: 'hand',
  r: 'table',
  '2': 'table',
  a: 'relation',
  '3': 'relation',
  t: 'note',
  '4': 'note',
  e: 'eraser',
  '0': 'eraser',
};

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

type Handle = { col?: Id; table: boolean };

function parseHandle(h: string | null | undefined): Handle {
  if (!h) return { table: true };
  const m = h.match(/^(.*)-(L|R|hL|hR|hT|hB)$/);
  if (!m) return { table: true };
  if (m[2].startsWith('h')) return { table: true };
  return { col: m[1], table: false };
}

/** Cria a FK entre duas tabelas, invertendo origem/destino quando o lado com PK foi arrastado primeiro */
function createFkConnection(srcId: Id, tgtId: Id, aIn: Handle, bIn: Handle, schema: SchemaModel): ConnectResult | undefined {
  let from = srcId;
  let to = tgtId;
  let a = aIn;
  let b = bIn;
  const ta = tableById(schema, from);
  const tb = tableById(schema, to);
  if (ta && tb) {
    const aIsPk = a.col ? ta.primaryKey.includes(a.col) : false;
    const bIsPk = b.col ? tb.primaryKey.includes(b.col) : b.table;
    if (aIsPk && !bIsPk) {
      [from, to] = [to, from];
      [a, b] = [b, a];
    }
    if (a.col && !b.col) {
      const target = tableById(schema, to)!;
      if (target.primaryKey.length === 1) b = { col: target.primaryKey[0], table: false };
    }
  }
  return connectTables(from, to, 'fk', { from: a.col, to: b.col });
}

type RelationOption = 'fk' | 'note' | 'nn';

interface PendingConnect {
  from: Id;
  to: Id;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  fromName: string;
  toName: string;
  x: number;
  y: number;
  /** Opções mostradas no popover — relações não-ambíguas pulam o popover inteiramente */
  options: RelationOption[];
}

function CanvasInner() {
  const doc = useProjectStore((s) => s.doc);
  const view = useProjectStore((s) => s.view);
  const name = useProjectStore((s) => s.name);
  const tool = useProjectStore((s) => s.tool);
  const readOnly = useProjectStore((s) => s.readOnly);
  const loaded = useProjectStore((s) => s.loaded);
  const setTool = useProjectStore((s) => s.setTool);
  const relationSource = useUi((s) => s.relationSource);
  const rf = useReactFlow();

  const project: Project = useMemo(() => ({ version: 1, name, view, ...doc }), [doc, view, name]);
  const derivedNodes = useMemo(() => deriveNodes(project, relationSource), [project, relationSource]);
  const derivedEdges = useMemo(() => deriveEdges(project), [project]);

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<ErdEdge[]>([]);
  const [spacePan, setSpacePan] = useState(false);
  const [erasing, setErasing] = useState<Set<Id> | null>(null);
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null);
  const pointerPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pendingSelect = useRef<Id | null>(null);
  const pendingSelectEdge = useRef<Id | null>(null);
  const forceDeselectNodes = useRef(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const uiSelectedNodes = useUi((s) => s.selectedNodes);
  const selectionRequest = useUi((s) => s.selectionRequest);

  // seleção restaurada junto com um undo/redo
  useEffect(() => {
    if (!selectionRequest) return;
    const ns = new Set(selectionRequest.nodes);
    const es = new Set(selectionRequest.edges);
    setNodes((nds) => nds.map((n) => ({ ...n, selected: ns.has(n.id) })));
    setEdges((eds) => eds.map((e) => ({ ...e, selected: es.has(e.id) })));
  }, [selectionRequest]);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      pointerPosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', handleMove, { passive: true });
    return () => window.removeEventListener('pointermove', handleMove);
  }, []);

  // nós derivados do modelo, preservando seleção/medidas/arrasto locais
  useEffect(() => {
    const sel = pendingSelect.current && derivedNodes.some((n) => n.id === pendingSelect.current) ? pendingSelect.current : null;
    const clearAll = forceDeselectNodes.current;
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return derivedNodes.map((n) => {
        const p = byId.get(n.id);
        const selected = sel ? n.id === sel : clearAll ? false : !!p?.selected;
        if (!p) return { ...n, selected };
        return { ...n, selected, measured: p.measured, dragging: p.dragging, position: p.dragging ? p.position : n.position };
      });
    });
    if (sel) {
      useUi.getState().set({ selectedNodes: [sel], selectedEdges: [] });
      pendingSelect.current = null;
    } else if (clearAll) {
      forceDeselectNodes.current = false;
    }
  }, [derivedNodes]);

  useEffect(() => {
    const selEdge = pendingSelectEdge.current && derivedEdges.some((e) => e.id === pendingSelectEdge.current) ? pendingSelectEdge.current : null;
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return derivedEdges.map((e) => ({ ...e, selected: selEdge ? e.id === selEdge : sel.has(e.id) }));
    });
    if (selEdge) {
      useUi.getState().set({ selectedNodes: [], selectedEdges: [selEdge] });
      pendingSelectEdge.current = null;
    }
  }, [derivedEdges]);

  // ajusta o zoom quando o projeto é carregado
  const fitted = useRef(false);
  useEffect(() => {
    if (loaded && !fitted.current && nodes.length) {
      fitted.current = true;
      setTimeout(() => rf.fitView({ padding: 0.15, maxZoom: 1.1 }), 50);
    }
  }, [loaded, nodes.length, rf]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), eds) as ErdEdge[]);
  }, []);

  const onSelectionChange = useCallback(({ nodes, edges }: OnSelectionChangeParams) => {
    useUi.getState().set({ selectedNodes: nodes.map((n) => n.id), selectedEdges: edges.map((e) => e.id) });
  }, []);

  const selectOnly = (id: Id) => {
    pendingSelect.current = id;
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
  };

  /** Seleciona o resultado de uma conexão (a nova relação, ou a nova tabela pivot) — nunca a última tabela clicada */
  const selectResult = (result?: ConnectResult) => {
    if (!result) return;
    if (result.kind === 'node') selectOnly(result.id);
    else {
      forceDeselectNodes.current = true;
      pendingSelectEdge.current = result.id;
    }
  };

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    const schema = useProjectStore.getState().doc.schema;
    const ta = tableById(schema, c.source);
    const tb = tableById(schema, c.target);
    if (!ta || !tb) return;

    const a = parseHandle(c.sourceHandle);
    const b = parseHandle(c.targetHandle);

    // atributo → atributo: FK é óbvia, não precisa de popover
    if (!a.table && !b.table) {
      const result = createFkConnection(c.source, c.target, a, b, schema);
      selectResult(result);
      if (useProjectStore.getState().tool === 'relation') useProjectStore.getState().setTool('select');
      return;
    }

    const rect = wrapper.current?.getBoundingClientRect();
    const x = pointerPosRef.current.x - (rect?.left ?? 0);
    const y = pointerPosRef.current.y - (rect?.top ?? 0);
    // tabela → tabela: ambíguo entre nota e pivot (FK não faz sentido sem coluna definida)
    // misto (atributo ↔ tabela): ambíguo entre FK e nota (pivot não se aplica a uma coluna específica)
    const options: RelationOption[] = a.table && b.table ? ['note', 'nn'] : ['fk', 'note'];

    setPendingConnect({
      from: c.source,
      to: c.target,
      sourceHandle: c.sourceHandle,
      targetHandle: c.targetHandle,
      fromName: ta.name,
      toName: tb.name,
      x,
      y,
      options,
    });
  }, []);

  const handleSelectRelationType = (type: RelationOption) => {
    if (!pendingConnect) return;
    const { from: srcId, to: tgtId, sourceHandle, targetHandle } = pendingConnect;
    const schema = useProjectStore.getState().doc.schema;
    const a = parseHandle(sourceHandle);
    const b = parseHandle(targetHandle);

    let result: ConnectResult | undefined;
    if (type === 'nn') {
      const id = createPivot(srcId, tgtId);
      result = id ? { kind: 'node', id } : undefined;
    } else if (type === 'note') {
      result = connectTables(srcId, tgtId, 'note', { from: a.col, to: b.col });
    } else {
      result = createFkConnection(srcId, tgtId, a, b, schema);
    }

    setPendingConnect(null);
    selectResult(result);
    if (useProjectStore.getState().tool === 'relation') useProjectStore.getState().setTool('select');
  };

  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      const t = useProjectStore.getState().tool;
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      useUi.getState().set({ relationSource: null, editing: null });
      if (t === 'table') {
        const id = createTable({ x: pos.x - 130, y: pos.y - 20 });
        selectOnly(id);
        useUi.getState().set({ editing: { kind: 'table-name', id } });
        setTool('select');
      } else if (t === 'note') {
        const id = createNote({ x: pos.x - 130, y: pos.y - 20 });
        selectOnly(id);
        setTool('select');
      }
    },
    [rf, setTool],
  );

  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    if (useProjectStore.getState().tool !== 'relation' || node.type !== 'table') return;
    const ui = useUi.getState();
    if (!ui.relationSource) ui.set({ relationSource: node.id });
    else {
      const result = connectTables(ui.relationSource, node.id, ui.relationMode);
      ui.set({ relationSource: null });
      useProjectStore.getState().setTool('select');
      selectResult(result);
    }
  }, []);

  // arraste (§4.5): durante o movimento a posição vai pela awareness (~30 Hz, efêmera);
  // no fim, um único commit grava a posição final (uma entrada de undo, um update persistido)
  const publishDrag = useMemo(() => throttle((items: { id: Id; x: number; y: number }[] | null) => setPresence(getSession(), { dragging: items }), 33), []);
  const onNodeDrag = useCallback(
    (_e: unknown, _n: Node, dragged: Node[]) => publishDrag(dragged.map((n) => ({ id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }))),
    [publishDrag],
  );
  const onNodeDragStop = useCallback((_e: unknown, _n: Node, dragged: Node[]) => {
    moveNodes(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
    publishDrag(null);
    setTimeout(() => setPresence(getSession(), { dragging: null }), 60);
  }, [publishDrag]);
  const remoteDrags = usePresence((s) => s.drags);

  /**
   * Duplo clique numa relação: foca em uma das duas tabelas (não as duas de uma vez — mais fácil de ver).
   * Duplo clique de novo na mesma relação alterna o foco para a outra tabela.
   */
  const edgeFocusSide = useRef<Map<string, 'source' | 'target'>>(new Map());
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: { id: string; source: string; target: string }) => {
      const last = edgeFocusSide.current.get(edge.id);
      const side = last === 'source' ? 'target' : 'source';
      edgeFocusSide.current.set(edge.id, side);
      const id = side === 'source' ? edge.source : edge.target;
      void rf.fitView({ nodes: [{ id }], padding: 0.4, duration: 400, maxZoom: 1.6 });
    },
    [rf],
  );

  /* ---------------- atalhos de teclado ---------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const ui = useUi.getState();
      // modo visualização: só navegação (selecionar, enquadrar, mão, ajuda)
      const readOnly = useProjectStore.getState().readOnly;
      if (readOnly && ((mod && (ARROWS[e.key] || /^[zyd]$/i.test(e.key))) || e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Enter')) return;
      if (e.key === ' ' && !e.repeat) {
        setSpacePan(true);
        e.preventDefault();
        return;
      }
      if (mod && ARROWS[e.key]) {
        const sel = ui.selectedNodes.filter((id) => tableById(useProjectStore.getState().doc.schema, id));
        if (!sel.length) return;
        e.preventDefault();
        const id = createRelatedTable(sel[0], ARROWS[e.key], e.shiftKey ? 'note' : 'fk');
        if (id) {
          selectOnly(id);
          useUi.getState().set({ editing: { kind: 'table-name', id } });
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const ids = duplicateTables(ui.selectedNodes);
        if (ids[0]) selectOnly(ids[0]);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteElements({ nodes: ui.selectedNodes, edges: ui.selectedEdges });
        return;
      }
      if (e.key === 'Escape') {
        setPendingConnect(null);
        setErasing(null);
        ui.set({ relationSource: null, editing: null });
        setTool('select');
        setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
        return;
      }
      if (e.key === 'Enter' && ui.selectedNodes.length === 1) {
        const id = ui.selectedNodes[0];
        const d = useProjectStore.getState().doc;
        if (d.schema.tables.some((t) => t.id === id)) ui.set({ editing: { kind: 'table-name', id } });
        else if (d.notes.some((n) => n.id === id)) ui.set({ editing: { kind: 'note', id } });
        e.preventDefault();
        return;
      }
      if (e.shiftKey && (e.key === '!' || e.code === 'Digit1')) {
        rf.fitView({ padding: 0.15, duration: 300 });
        return;
      }
      if (e.key === '?') {
        ui.set({ helpOpen: true });
        return;
      }
      if (!mod && !e.altKey && !e.shiftKey && TOOL_KEYS[e.key.toLowerCase()]) {
        if (readOnly && !['select', 'hand'].includes(TOOL_KEYS[e.key.toLowerCase()])) return;
        setTool(TOOL_KEYS[e.key.toLowerCase()]);
        ui.set({ relationSource: null });
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpacePan(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [rf, setTool]);

  /* ---------------- eraser ---------------- */
  const hitAt = (x: number, y: number): Id | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const n = el.closest('.react-flow__node, .react-flow__edge') as HTMLElement | null;
      if (n?.dataset.id) return n.dataset.id;
    }
    return null;
  };
  const eraserDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const s = new Set<Id>();
    const id = hitAt(e.clientX, e.clientY);
    if (id) s.add(id);
    setErasing(s);
  };
  const eraserMove = (e: React.PointerEvent) => {
    if (!erasing) return;
    const id = hitAt(e.clientX, e.clientY);
    if (id && !erasing.has(id)) setErasing(new Set([...erasing, id]));
  };
  const eraserUp = () => {
    if (!erasing) return;
    const ids = [...erasing];
    setErasing(null);
    const nodeIds = new Set(nodes.map((n) => n.id));
    deleteElements({ nodes: ids.filter((i) => nodeIds.has(i)), edges: ids.filter((i) => !nodeIds.has(i)) });
  };

  // destaca a(s) tabela(s) selecionada(s) e as tabelas com que fazem relação DIRETA de FK ou nota
  // (arestas de enum não contam, e só um salto — não propaga por tabelas intermediárias), apagando o resto
  const selectedTableIds = useMemo(() => uiSelectedNodes.filter((id) => tableById(doc.schema, id)), [uiSelectedNodes, doc.schema]);
  const highlightSet = useMemo(() => {
    if (!selectedTableIds.length) return null;
    const selected = new Set<Id>(selectedTableIds);
    const keep = new Set<Id>(selectedTableIds);
    for (const e of derivedEdges) {
      const variant = e.data?.variant;
      if (variant !== 'fk' && variant !== 'note' && variant !== 'nn') continue;
      const s = e.source as Id;
      const t = e.target as Id;
      // checa contra `selected` (fixo), não `keep` (que vai crescendo) — senão um salto vira cascata
      if (selected.has(s)) keep.add(t);
      if (selected.has(t)) keep.add(s);
    }
    return keep;
  }, [selectedTableIds, derivedEdges]);

  const shownNodes = useMemo(() => {
    let base = nodes;
    if (highlightSet) {
      base = base.map((n) => {
        if (n.type !== 'table' && n.type !== 'enum') return n;
        // filtro, não opacidade: opacidade deixaria o card translúcido e as arestas por trás apareceriam
        return highlightSet.has(n.id) ? n : { ...n, className: [n.className, 'erd-dimmed-node'].filter(Boolean).join(' ') };
      });
    }
    if (remoteDrags.size) {
      // nó que outra pessoa está arrastando: segue ao vivo, com a borda na cor dela
      base = base.map((n) => {
        const d = remoteDrags.get(n.id);
        if (!d || n.dragging) return n;
        return { ...n, position: { x: d.x, y: d.y }, style: { ...n.style, outline: `2px solid ${d.color}`, outlineOffset: 3, borderRadius: 10 }, draggable: false };
      });
    }
    return erasing?.size ? base.map((n) => (erasing.has(n.id) ? { ...n, className: 'erd-erasing' } : n)) : base;
  }, [nodes, erasing, highlightSet, remoteDrags]);
  const shownEdges = useMemo(() => {
    let base = edges;
    if (highlightSet) {
      const selected = new Set<Id>(selectedTableIds);
      base = base.map((e) => {
        if (!e.data) return e;
        // só a relação ligada DIRETAMENTE à tabela selecionada é destacada — todo o resto apaga,
        // mesmo arestas entre duas tabelas "relacionadas" (ex.: users-posts quando companies está selecionada)
        const variant = e.data.variant;
        const direct = (variant === 'fk' || variant === 'note' || variant === 'nn') && (selected.has(e.source as Id) || selected.has(e.target as Id));
        // a opacidade/cor são controladas dentro do componente da aresta (via `data`), não por className:
        // um estilo inline no componente sempre venceria uma classe CSS externa
        return { ...e, data: { ...e.data, emphasized: direct, dimmed: !direct } satisfies ErdEdge['data'] };
      });
    }
    return erasing?.size ? base.map((e) => (erasing.has(e.id) ? { ...e, className: 'erd-erasing' } : e)) : base;
  }, [edges, erasing, highlightSet, selectedTableIds]);

  const panning = tool === 'hand' || spacePan;
  const cursor = panning ? 'grab' : tool === 'table' || tool === 'note' ? 'crosshair' : tool === 'relation' ? 'cell' : undefined;

  return (
    <div ref={wrapper} className={'relative h-full w-full tool-' + tool} style={{ cursor }}>
      <ErdMarkers />
      <TypeDatalist />
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
        onNodeClick={onNodeClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onEdgeDoubleClick={onEdgeDoubleClick}
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        panOnDrag={panning ? true : [1, 2]}
        selectionOnDrag={!panning && tool === 'select'}
        selectionMode={SelectionMode.Partial}
        nodesDraggable={!panning && tool !== 'relation' && !readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!panning}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={nodes.length > 150}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cbd5e1" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap position="bottom-right" style={{ width: 150, height: 96, marginRight: 52 }} pannable zoomable nodeStrokeWidth={2} nodeColor={(n) => (n.type === 'note' ? '#fde68a' : n.type === 'enum' ? '#a7f3d0' : '#c7d2fe')} />
      </ReactFlow>
      <Toolbar />
      <Inspector />
      <Legend />
      {pendingConnect && (
        <>
          <div className="absolute inset-0 z-20" onClick={() => setPendingConnect(null)} />
          <div
            className="absolute z-30 w-72 rounded-xl border border-slate-200 bg-white/98 p-3 shadow-xl backdrop-blur-xs"
            style={{
              left: Math.max(12, Math.min(pendingConnect.x - 20, (wrapper.current?.clientWidth ?? 600) - 300)),
              top: Math.max(12, Math.min(pendingConnect.y - 20, (wrapper.current?.clientHeight ?? 600) - 260)),
            }}
          >
            <div className="mb-2.5 flex items-center justify-between border-b border-slate-100 pb-2">
              <div>
                <div className="text-[12px] font-semibold text-slate-800">Criar Relação</div>
                <div className="truncate text-[10.5px] text-slate-500 max-w-[210px]">
                  <span className="font-medium text-slate-700">{pendingConnect.fromName}</span>
                  <span className="mx-1 text-slate-400">→</span>
                  <span className="font-medium text-slate-700">{pendingConnect.toName}</span>
                </div>
              </div>
              <button
                onClick={() => setPendingConnect(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                title="Cancelar (Esc)"
              >
                <X size={14} />
              </button>
            </div>
            <div className="space-y-1.5">
              {pendingConnect.options.includes('fk') && (
                <button
                  onClick={() => handleSelectRelationType('fk')}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200/80 p-2 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50 group"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600 group-hover:bg-indigo-100 group-hover:text-indigo-600">
                    <Link2 size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] font-semibold text-slate-700 group-hover:text-indigo-700">Chave Estrangeira (FK)</div>
                    <div className="text-[10px] text-slate-400">Adiciona FK e integridade relacional</div>
                  </div>
                </button>
              )}

              {pendingConnect.options.includes('note') && (
                <button
                  onClick={() => handleSelectRelationType('note')}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200/80 p-2 text-left transition hover:border-purple-300 hover:bg-purple-50/50 group"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-600 group-hover:bg-purple-200 group-hover:text-purple-700">
                    <FileText size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] font-semibold text-slate-700 group-hover:text-purple-700">Relação de Nota</div>
                    <div className="text-[10px] text-slate-400">Apenas anotação lógica (sem FK)</div>
                  </div>
                </button>
              )}

              {pendingConnect.options.includes('nn') && (
                <button
                  onClick={() => handleSelectRelationType('nn')}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200/80 p-2 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50 group"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-600 group-hover:bg-indigo-200 group-hover:text-indigo-700">
                    <Table2 size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] font-semibold text-slate-700 group-hover:text-indigo-700">Tabela Pivot (N:N)</div>
                    <div className="text-[10px] text-slate-400">Cria tabela associativa intermediária</div>
                  </div>
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {tool === 'eraser' && (
        <div className="erd-eraser-overlay absolute inset-0 z-10" onPointerDown={eraserDown} onPointerMove={eraserMove} onPointerUp={eraserUp} />
      )}
      {tool === 'relation' && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-800/90 px-3 py-1.5 text-xs text-white">
          {relationSource ? 'Agora clique na tabela de destino (referenciada)' : 'Clique na tabela de origem (que recebe a FK) — ou arraste entre colunas'}
        </div>
      )}
    </div>
  );
}

/** Requer um <ReactFlowProvider> acima (o App o fornece para o diálogo de export) */
export function Canvas() {
  return <CanvasInner />;
}

export { ReactFlowProvider };
