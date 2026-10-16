import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Annotation, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Diagnostic } from '../formats/common';

/** Marca transações vindas do modelo — o listener não agenda novo parse para elas */
export const Remote = Annotation.define<boolean>();

interface Props {
  value: string;
  language: Extension;
  diagnostics?: Diagnostic[];
  onChange?: (text: string) => void;
  onSave?: () => void;
  onBlur?: () => void;
  readOnly?: boolean;
  className?: string;
  /** Posição (offset) a rolar e selecionar — só dispara quando `revealToken` muda */
  revealOffset?: number | null;
  revealToken?: number | null;
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--editor-bg)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--editor-gutter)', borderRight: '1px solid var(--border)', color: 'var(--muted)' },
  '.cm-activeLineGutter, .cm-activeLine': { backgroundColor: 'var(--editor-active)' },
  '&.cm-focused': { outline: 'none' },
});

export function CodeEditor({ value, language, diagnostics, onChange, onSave, onBlur, readOnly, className, revealOffset, revealToken }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave, onBlur });
  handlers.current = { onChange, onSave, onBlur };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language,
          lintGutter(),
          theme,
          EditorState.readOnly.of(!!readOnly),
          keymap.of([
            indentWithTab,
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave?.();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (u.transactions.some((tr) => tr.annotation(Remote))) return;
            handlers.current.onChange?.(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              handlers.current.onBlur?.();
              return false;
            },
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // o editor é criado uma vez; `value` é sincronizado no efeito abaixo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // texto vindo do modelo: aplica só o trecho que mudou, como transação remota sem histórico
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === value) return;
    let start = 0;
    while (start < cur.length && start < value.length && cur[start] === value[start]) start++;
    let endCur = cur.length;
    let endNew = value.length;
    while (endCur > start && endNew > start && cur[endCur - 1] === value[endNew - 1]) {
      endCur--;
      endNew--;
    }
    v.dispatch({
      changes: { from: start, to: endCur, insert: value.slice(start, endNew) },
      annotations: [Remote.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    const diags: CmDiagnostic[] = (diagnostics ?? []).map((d) => {
      const from = Math.max(0, Math.min(len, d.from));
      return { from, to: Math.max(from, Math.min(len, d.to)), severity: d.severity, message: d.message };
    });
    v.dispatch(setDiagnostics(v.state, diags));
  }, [diagnostics, value]);

  // "ver em código": rola até a posição pedida e seleciona a linha — só no gatilho (revealToken), nunca ao digitar
  useEffect(() => {
    const v = view.current;
    if (!v || revealToken == null || revealOffset == null) return;
    const pos = Math.max(0, Math.min(v.state.doc.length, revealOffset));
    const line = v.state.doc.lineAt(pos);
    v.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    v.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  return <div ref={host} className={className} />;
}
