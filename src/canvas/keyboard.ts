/**
 * Atalhos do canvas não devem disparar quando o foco está num campo de texto
 * (no Windows, Ctrl+Seta é navegação por palavra; no CodeMirror, Ctrl+Z é o undo local).
 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t.closest('.cm-editor')) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
