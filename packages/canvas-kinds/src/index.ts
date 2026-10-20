import type { ComponentType } from 'react';
import type { Edge, EdgeTypes, Node, NodeTypes } from '@xyflow/react';
import type * as Y from 'yjs';

/**
 * Contrato de um "tipo de canvas" (§8.3). O editor fala com esta interface, então o canvas
 * de fluxos de usuário (fase 8) só adiciona um tipo novo, sem copiar nem refatorar o ERD.
 *
 * Compartilhado entre os tipos (fica no editor): presença, autoria, undo, conexão, export de
 * imagem, notas, minimap, arrasto via awareness e permissões. Específico de cada tipo: nós,
 * arestas, toolbar, inspector e painéis laterais.
 */
export interface CanvasKind<P = unknown, V = unknown> {
  kind: 'erd' | 'flow';
  label: string;
  /** `false` enquanto o tipo não pode ser criado nem aberto (a aba aparece como "em breve") */
  available: boolean;
  /** Schema do Y.Doc + projeção + diff (em @erd/crdt para o ERD) */
  doc: {
    init(ydoc: Y.Doc): void;
    project(ydoc: Y.Doc): P;
    applyDiff(ydoc: Y.Doc, before: P, after: P): boolean;
  };
  nodeTypes: NodeTypes;
  edgeTypes: EdgeTypes;
  /** Projeto → nós e arestas do React Flow (no ERD: canvas/derive.ts) */
  derive(p: P, view: V): { nodes: Node[]; edges: Edge[] };
  Toolbar: ComponentType;
  Inspector: ComponentType;
  /** Painéis ao lado do canvas (ERD: os editores SQL/Prisma/Drizzle) */
  SidePanels?: ComponentType;
  shortcuts: Record<string, string>;
  exporters: Exporter<P>[];
}

export interface Exporter<P = unknown> {
  id: string;
  label: string;
  /** Extensão sugerida, ex.: `.sql` */
  ext: string;
  run(p: P): Promise<Blob> | Blob;
}

const registry = new Map<string, CanvasKind<never, never>>();

export function registerKind<P, V>(k: CanvasKind<P, V>) {
  registry.set(k.kind, k as unknown as CanvasKind<never, never>);
  return k;
}

export function getKind<P = unknown, V = unknown>(kind: string): CanvasKind<P, V> | undefined {
  return registry.get(kind) as unknown as CanvasKind<P, V> | undefined;
}

export const kinds = () => [...registry.values()];
