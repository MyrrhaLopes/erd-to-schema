import { bindStore } from '../store/useProjectStore';
import { useUi } from '../store/useUi';
import { bindPanels } from '../sync/panels';
import { setSession, type Session } from './session';

let unbind: (() => void) | null = null;

/**
 * Ativa uma sessão de canvas: liga projeção, painéis e undo à interface. A seleção vai
 * junto com cada entrada de undo e volta quando ela é desfeita.
 */
export function activateSession(session: Session) {
  deactivateSession();
  setSession(session);
  const offStore = bindStore(session);
  const offPanels = bindPanels(session);
  const onAdded = (e: { stackItem: { meta: Map<string, unknown> } }) => {
    const ui = useUi.getState();
    e.stackItem.meta.set('selection', { nodes: ui.selectedNodes, edges: ui.selectedEdges });
  };
  const onPopped = (e: { stackItem: { meta: Map<string, unknown> } }) => {
    const sel = e.stackItem.meta.get('selection') as { nodes: string[]; edges: string[] } | undefined;
    if (sel) useUi.getState().set({ selectionRequest: { ...sel, nonce: Date.now() } });
  };
  session.undo.on('stack-item-added', onAdded);
  session.undo.on('stack-item-popped', onPopped);
  unbind = () => {
    session.undo.off('stack-item-added', onAdded);
    session.undo.off('stack-item-popped', onPopped);
    offPanels();
    offStore();
  };
}

/** Fecha o canvas atual (ao trocar de rota): nada fica vivo entre projetos */
export function deactivateSession() {
  unbind?.();
  unbind = null;
  setSession(null);
}
