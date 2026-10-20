import { registerKind } from '@erd/canvas-kinds';
import type { Project } from '@erd/model/types';
import { applyDiff, Projector, type ProjectDoc } from '@erd/crdt';
import { buildProjectZip } from '@erd/model/projectFile';
import { GENERATORS } from '@erd/sync';
import type { ViewState } from '@erd/model/types';
import { TableNode } from '../canvas/nodes/TableNode';
import { EnumNode } from '../canvas/nodes/EnumNode';
import { NoteNode } from '../canvas/nodes/NoteNode';
import { ErdEdgeComponent } from '../canvas/edges/edges';
import { deriveEdges, deriveNodes } from '../canvas/derive';
import { Toolbar } from '../canvas/Toolbar';
import { Inspector } from '../canvas/Inspector';
import { CodePanel } from '../ui/CodePanel';

const text = (s: string) => new Blob([s], { type: 'text/plain' });

/** O canvas ERD como um "tipo de canvas" (§8.3) */
export const erdKind = registerKind<Project, ViewState>({
  kind: 'erd',
  label: 'Diagrama ER',
  available: true,
  doc: {
    init: () => {},
    project: (ydoc) => ({ version: 1, ...new Projector(ydoc).current, view: {} as ViewState }) as Project,
    applyDiff: (ydoc, before, after) => applyDiff(ydoc, before as ProjectDoc, after as ProjectDoc),
  },
  nodeTypes: { table: TableNode, enum: EnumNode, note: NoteNode },
  edgeTypes: { erd: ErdEdgeComponent },
  derive: (p, view) => {
    const project = { ...p, view };
    return { nodes: deriveNodes(project, null), edges: deriveEdges(project) };
  },
  Toolbar,
  Inspector,
  SidePanels: CodePanel,
  shortcuts: { V: 'Seleção', R: 'Tabela', A: 'Relação', T: 'Nota', E: 'Borracha' },
  exporters: [
    { id: 'zip', label: 'Projeto (.zip)', ext: '.erd.zip', run: (p) => new Blob([buildProjectZip(p) as BlobPart], { type: 'application/zip' }) },
    { id: 'sql', label: 'SQL (Postgres)', ext: '.sql', run: (p) => text(GENERATORS.sql(p)) },
    { id: 'prisma', label: 'Prisma', ext: '.prisma', run: (p) => text(GENERATORS.prisma(p)) },
    { id: 'drizzle', label: 'Drizzle', ext: '.schema.ts', run: (p) => text(GENERATORS.drizzle(p)) },
  ],
});

/** Fluxos de usuário (§9): só o lugar reservado — a aba aparece como "em breve" */
export const flowKind = registerKind<unknown, unknown>({
  kind: 'flow',
  label: 'Fluxos de usuário',
  available: false,
  doc: { init: () => {}, project: () => ({}), applyDiff: () => false },
  nodeTypes: {},
  edgeTypes: {},
  derive: () => ({ nodes: [], edges: [] }),
  Toolbar: () => null,
  Inspector: () => null,
  shortcuts: {},
  exporters: [],
});
