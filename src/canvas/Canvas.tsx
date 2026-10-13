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
import type { Id, Project } from '../model/types';
import { useProjectStore, undo, redo } from '../store/useProjectStore';
import { useUi } from '../store/useUi';
import {
  connectTables,
  createNote,
  createRelatedTable,
  createTable,
  deleteElements,
  duplicateTables,
  moveNodes,
  type Direction,
} from '../store/actions';
import { deriveEdges, deriveNodes } from './derive';
import { TableNode, TypeDatalist } from './nodes/TableNode';
import { EnumNode } from './nodes/EnumNode';
import { NoteNode } from './nodes/NoteNode';
import { ErdEdgeComponent, ErdMarkers, type ErdEdge } from './edges/edges';
import { Toolbar } from './Toolbar';
import { Inspector } from './Inspector';
import { isTypingTarget } from './keyboard';
import { tableById } from '../model/schema';

const nodeTypes = { table: TableNode, enum: EnumNode, note: NoteNode };
const edgeTypes = { erd: ErdEdgeComponent };

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

function parseHandle(h: string | null | undefined): { col?: Id; table: boolean } {
  if (!h) return { table: true };
  const m = h.match(/^(.*)-(L|R|hL|hR)$/);
  if (!m) return { table: true };
  if (m[2].startsWith('h')) return { table: true };
  return { col: m[1], table: false };
}

function CanvasInner() {
  const doc = useProjectStore((s) => s.doc);
  const view = useProjectStore((s) => s.view);
  const name = useProjectStore((s) => s.name);
  const tool = useProjectStore((s) => s.tool);
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
  const pendingSelect = useRef<Id | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  // nós derivados do modelo, preservando seleção/medidas/arrasto locais
  useEffect(() => {
    const sel = pendingSelect.current && derivedNodes.some((n) => n.id === pendingSelect.current) ? pendingSelect.current : null;
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return derivedNodes.map((n) => {
        const p = byId.get(n.id);
        const selected = sel ? n.id === sel : !!p?.selected;
        if (!p) return { ...n, selected };
        return { ...n, selected, measured: p.measured, dragging: p.dragging, position: p.dragging ? p.position : n.position };
      });
    });
    if (sel) {
      useUi.getState().set({ selectedNodes: [sel], selectedEdges: [] });
      pendingSelect.current = null;
    }
  }, [derivedNodes]);

  useEffect(() => {
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return derivedEdges.map((e) => ({ ...e, selected: sel.has(e.id) }));
    });
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

  const onConnect = useCallback((c: Connection) => {
    const mode = useUi.getState().relationMode;
    let from = c.source;
    let to = c.target;
    let a = parseHandle(c.sourceHandle);
    let b = parseHandle(c.targetHandle);
    const schema = useProjectStore.getState().doc.schema;
    // arrastar a partir de uma PK para outra coluna: a FK fica no destino
    const ta = tableById(schema, from);
    const tb = tableById(schema, to);
    if (!ta || !tb) return;
    const aIsPk = a.col ? ta.primaryKey.includes(a.col) : false;
    const bIsPk = b.col ? tb.primaryKey.includes(b.col) : b.table;
    if (mode === 'fk' && aIsPk && !bIsPk) {
      [from, to] = [to, from];
      [a, b] = [b, a];
    }
    if (mode === 'fk' && a.col && !b.col) {
      // coluna → tabela: referencia a PK da tabela destino
      const target = tableById(schema, to)!;
      if (target.primaryKey.length === 1) b = { col: target.primaryKey[0], table: false };
    }
    connectTables(from, to, mode, { from: a.col, to: b.col });
    if (useProjectStore.getState().tool === 'relation') useProjectStore.getState().setTool('select');
  }, []);

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
      connectTables(ui.relationSource, node.id, ui.relationMode);
      ui.set({ relationSource: null });
      useProjectStore.getState().setTool('select');
    }
  }, []);

  const onNodeDragStop = useCallback((_e: unknown, _n: Node, dragged: Node[]) => {
    moveNodes(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
  }, []);

  /* ---------------- atalhos de teclado ---------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const ui = useUi.getState();
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

  const shownNodes = useMemo(
    () => (erasing?.size ? nodes.map((n) => (erasing.has(n.id) ? { ...n, className: 'erd-erasing' } : n)) : nodes),
    [nodes, erasing],
  );
  const shownEdges = useMemo(
    () => (erasing?.size ? edges.map((e) => (erasing.has(e.id) ? { ...e, className: 'erd-erasing' } : e)) : edges),
    [edges, erasing],
  );

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
        onNodeDragStop={onNodeDragStop}
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        panOnDrag={panning ? true : [1, 2]}
        selectionOnDrag={!panning && tool === 'select'}
        selectionMode={SelectionMode.Partial}
        nodesDraggable={!panning && tool !== 'relation'}
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
