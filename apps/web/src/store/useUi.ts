import { create } from 'zustand';
import type { Format, Id } from '@erd/model/types';
import { useProjectStore } from './useProjectStore';

export type RelationMode = 'fk' | 'note' | 'nn';

interface UiState {
  selectedNodes: Id[];
  selectedEdges: Id[];
  relationMode: RelationMode;
  /** Primeiro clique do modo relação (clique-clique) */
  relationSource: Id | null;
  editing: { kind: 'table-name' | 'column' | 'note'; id: Id; colId?: Id } | null;
  panelOpen: boolean;
  panelTab: Format;
  panelWidth: number;
  exportOpen: boolean;
  helpOpen: boolean;
  toast: string | null;
  /** Pedido de "ver em código": abre o painel e pede ao editor pra rolar até a definição da tabela */
  jumpToTable: { id: Id; nonce: number } | null;
  /** Seleção a restaurar no canvas (ex.: junto com um undo) */
  selectionRequest: { nodes: Id[]; edges: Id[]; nonce: number } | null;
  /** "Mostrar autoria" (§5.5): pinta cada entidade e trecho de texto com a cor de quem editou por último */
  showAuthorship: boolean;
  set: (p: Partial<UiState>) => void;
}

export const useUi = create<UiState>((set) => ({
  selectedNodes: [],
  selectedEdges: [],
  relationMode: 'fk',
  relationSource: null,
  editing: null,
  panelOpen: true,
  panelTab: 'sql',
  panelWidth: 520,
  exportOpen: false,
  helpOpen: false,
  toast: null,
  jumpToTable: null,
  selectionRequest: null,
  showAuthorship: false,
  // no modo visualização nada entra em edição inline (a API e o collab recusariam de qualquer forma)
  set: (p) => set(p.editing && useProjectStore.getState().readOnly ? { ...p, editing: null } : p),
}));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(msg: string) {
  useUi.getState().set({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => useUi.getState().set({ toast: null }), 2600);
}

/** Abre o painel de código e pede pra rolar até a definição da tabela (aba atual) */
export function revealTableInCode(id: Id) {
  useUi.getState().set({ panelOpen: true, jumpToTable: { id, nonce: Date.now() } });
}
