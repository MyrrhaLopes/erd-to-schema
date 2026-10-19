import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Diagnostic } from '@erd/model/formats/common';

interface Props {
  /** Texto compartilhado: a digitação vai direto para o Y.Text (y-codemirror.next) */
  ytext: Y.Text;
  awareness?: Awareness;
  language: Extension;
  diagnostics?: Diagnostic[];
  /** Trechos realçados (ex.: blocos divergentes) */
  marks?: { from: number; to: number; className: string }[];
  onSave?: () => void;
  onBlur?: () => void;
  onFormat?: () => void;
  readOnly?: boolean;
  className?: string;
  /** Posição (offset) a rolar e selecionar — só dispara quando `revealToken` muda */
  revealOffset?: number | null;
  revealToken?: number | null;
}

export interface CodeEditorHandle {
  /** Substitui o texto inteiro como uma edição normal (entra no undo do editor) */
  replaceAll(text: string): void;
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--editor-bg)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--editor-gutter)', borderRight: '1px solid var(--border)', color: 'var(--muted)' },
  '.cm-activeLineGutter, .cm-activeLine': { backgroundColor: 'var(--editor-active)' },
  '&.cm-focused': { outline: 'none' },
  '.erd-divergent': { backgroundColor: '#fef3c7', boxShadow: 'inset 3px 0 0 #f59e0b' },
});

const setMarks = StateEffect.define<{ from: number; to: number; className: string }[]>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const len = tr.state.doc.length;
      for (const m of [...e.value].sort((a, c) => a.from - c.from)) {
        const from = Math.max(0, Math.min(len, m.from));
        const to = Math.max(from, Math.min(len, m.to));
        // decoração de linha em cada linha do trecho
        for (let pos = from; pos <= to; ) {
          const line = tr.state.doc.lineAt(pos);
          b.add(line.from, line.from, Decoration.line({ class: m.className }));
          if (line.to >= to) break;
          pos = line.to + 1;
        }
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** O `basicSetup` sem o histórico do CodeMirror: o undo do editor é o do Yjs (desfaz só a sua digitação) */
const setup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...lintKeymap]),
];

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { ytext, awareness, language, diagnostics, marks, onSave, onBlur, onFormat, readOnly, className, revealOffset, revealToken },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onSave, onBlur, onFormat });
  handlers.current = { onSave, onBlur, onFormat };

  useImperativeHandle(ref, () => ({
    replaceAll(text: string) {
      const v = view.current;
      if (!v) return;
      const cur = v.state.doc.toString();
      if (cur === text) return;
      let s = 0;
      while (s < cur.length && s < text.length && cur[s] === text[s]) s++;
      let ec = cur.length;
      let en = text.length;
      while (ec > s && en > s && cur[ec - 1] === text[en - 1]) {
        ec--;
        en--;
      }
      v.dispatch({ changes: { from: s, to: ec, insert: text.slice(s, en) } });
    },
  }));

  useEffect(() => {
    const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set() });
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          setup,
          language,
          lintGutter(),
          theme,
          marksField,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          yCollab(ytext, awareness ?? null, { undoManager }),
          keymap.of([
            ...yUndoManagerKeymap,
            indentWithTab,
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave?.();
                return true;
              },
            },
            {
              key: 'Shift-Alt-f',
              preventDefault: true,
              run: () => {
                handlers.current.onFormat?.();
                return true;
              },
            },
          ]),
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
    return () => {
      v.destroy();
      undoManager.destroy();
      view.current = null;
    };
  }, [ytext, awareness, language, readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    const diags: CmDiagnostic[] = (diagnostics ?? []).map((d) => {
      const from = Math.max(0, Math.min(len, d.from));
      return { from, to: Math.max(from, Math.min(len, d.to)), severity: d.severity, message: d.message };
    });
    v.dispatch(setDiagnostics(v.state, diags));
  }, [diagnostics, ytext]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of(marks ?? []) });
  }, [marks, ytext]);

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
});
