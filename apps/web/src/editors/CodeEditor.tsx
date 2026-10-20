import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
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
import { bindAuthorship, bindTypingTrail, collabDecorations } from './collabDecor';

interface Props {
  /** Texto compartilhado: a digitação vai direto para o Y.Text (y-codemirror.next) */
  ytext: Y.Text;
  awareness?: Awareness;
  language: Extension;
  diagnostics?: Diagnostic[];
  /** Trechos realçados (ex.: blocos divergentes; faixa na cor de quem seleciona a tabela) */
  marks?: EditorMark[];
  onSave?: () => void;
  onBlur?: () => void;
  onFormat?: () => void;
  readOnly?: boolean;
  className?: string;
  /** Posição (offset) a rolar e selecionar — só dispara quando `revealToken` muda */
  revealOffset?: number | null;
  revealToken?: number | null;
  /** Sem gutters (editor de nota) */
  minimal?: boolean;
  /** Esc ou Ctrl+Enter: sair do editor */
  onExit?: () => void;
  /** "Mostrar autoria": pinta cada trecho com a cor de quem o escreveu */
  authorship?: boolean;
  /** Posição do cursor (ou `null` ao sair do editor), para a ponte painel ⇄ canvas */
  onCursor?: (offset: number | null) => void;
}

export interface EditorMark {
  from: number;
  to: number;
  className: string;
  /** Faixa na margem esquerda, na cor de alguém */
  color?: string;
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

const setMarks = StateEffect.define<EditorMark[]>();
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
          b.add(line.from, line.from, Decoration.line({ class: m.className, attributes: m.color ? { style: `box-shadow: inset 3px 0 0 ${m.color}` } : undefined }));
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

/** Editor de nota: sem números de linha nem dobras */
const minimalSetup: Extension = [
  highlightSpecialChars(),
  drawSelection(),
  dropCursor(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  keymap.of([...defaultKeymap, ...searchKeymap]),
];

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { ytext, awareness, language, diagnostics, marks, onSave, onBlur, onFormat, readOnly, className, revealOffset, revealToken, minimal, onExit, authorship, onCursor },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onSave, onBlur, onFormat, onExit, onCursor });
  handlers.current = { onSave, onBlur, onFormat, onExit, onCursor };

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
          minimal ? minimalSetup : setup,
          language,
          minimal ? [] : lintGutter(),
          collabDecorations,
          minimal ? EditorView.lineWrapping : [],
          theme,
          marksField,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          yCollab(ytext, awareness ?? null, { undoManager }),
          // sair do editor (notas) vence o Ctrl+Enter/Esc padrões do CodeMirror
          Prec.highest(
            keymap.of(
              ['Escape', 'Mod-Enter'].map((key) => ({
                key,
                run: () => {
                  if (!handlers.current.onExit) return false;
                  handlers.current.onExit();
                  return true;
                },
              })),
            ),
          ),
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
              handlers.current.onCursor?.(null);
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if ((u.selectionSet || u.focusChanged) && u.view.hasFocus) handlers.current.onCursor?.(u.state.selection.main.head);
          }),
        ],
      }),
    });
    view.current = v;
    const offTrail = bindTypingTrail(v, ytext, awareness);
    return () => {
      offTrail();
      v.destroy();
      undoManager.destroy();
      view.current = null;
    };
  }, [ytext, awareness, language, readOnly, minimal]);

  useEffect(() => {
    const v = view.current;
    if (!v || !authorship) return;
    return bindAuthorship(v, ytext, awareness);
  }, [authorship, ytext, awareness, readOnly, minimal]);

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
