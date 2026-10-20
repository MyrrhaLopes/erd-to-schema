import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import * as Y from 'yjs';
import type { DocContent, EntityMeta, Format, Id, LayoutEntry, NoteBlock, Origin, Project, SchemaModel, Tool, ViewState } from '@erd/model/types';
import { FORMATS } from '@erd/model/types';
import { defaultView, emptyProject, placeNewEntities } from '@erd/model/project';
import { sanitizeSchema } from '@erd/model/schema';
import { applyDiff, codeText, isBotOrigin, LOAD_ORIGIN, LOCAL_ORIGIN, Projector, roots, type ProjectDoc } from '@erd/crdt';
import { readSync } from '@erd/sync';
import { getSession, type Session } from '../collab/session';

/** Parte do projeto que vem do documento compartilhado (a projeção do Y.Doc) */
export interface Doc {
  schema: SchemaModel;
  layout: Record<Id, LayoutEntry>;
  meta: Record<Id, EntityMeta>;
  notes: NoteBlock[];
  /** Formulário do documento Word (raiz `doc`); ausente = vazio */
  doc?: DocContent;
}

export interface ChangeReport {
  id: number;
  origin: Origin;
  items: string[];
}

interface State {
  name: string;
  /** Projeção somente-leitura do Y.Doc: toda escrita passa por `commit` */
  doc: Doc;
  /** Preferência de cada pessoa (filtros, estilo): fica no localStorage, fora do documento */
  view: ViewState;
  rev: number;
  lastOrigin: Origin;
  report: ChangeReport | null;
  tool: Tool;
  loaded: boolean;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;

  commit: (recipe: (d: Draft<Doc>) => void, origin: Origin, changes?: string[]) => void;
  loadProject: (p: Project, origin?: Origin) => void;
  setName: (name: string) => void;
  setView: (recipe: (v: Draft<ViewState>) => void) => void;
  setTool: (tool: Tool) => void;
  dismissReport: () => void;
}

let reportSeq = 0;
/** Origem informada pelo último `commit`, para rotular a transação local que ele gera */
let pendingOrigin: Origin | null = null;

const emptyDoc = (): Doc => ({ schema: emptyProject().schema, layout: {}, meta: {}, notes: [] });

export const useProjectStore = create<State>()((set, get) => ({
  name: 'Novo projeto',
  doc: emptyDoc(),
  view: defaultView(),
  rev: 0,
  lastOrigin: 'load' as Origin,
  report: null,
  tool: 'select' as Tool,
  loaded: false,
  canUndo: false,
  canRedo: false,
  readOnly: false,

  commit: (recipe, origin, changes) => {
    const s = get();
    const session = getSession();
    if (!session || s.readOnly) return;
    const after = produce(s.doc, (d) => {
      recipe(d);
    });
    if (after === s.doc) return;
    // mesmas regras de antes: referências penduradas saem e entidades novas ganham posição
    const fixed = produce(after, (d) => {
      sanitizeSchema(d.schema as SchemaModel);
      placeNewEntities(d as Doc);
    });
    pendingOrigin = origin;
    try {
      session.doc.transact(
        () => applyDiff(session.doc, { name: s.name, ...s.doc }, { name: s.name, ...fixed }, { by: session.userId, at: Date.now() }),
        LOCAL_ORIGIN,
      );
    } finally {
      pendingOrigin = null;
    }
    if (changes?.length) set({ report: { id: ++reportSeq, origin, items: changes } });
  },

  loadProject: (p, origin = 'load') => {
    const session = getSession();
    if (!session) return;
    replaceDocument(session, p);
    set({ view: { ...defaultView(), ...p.view }, lastOrigin: origin });
    saveView(session.key, get().view);
  },

  setName: (name) => {
    const s = get();
    const session = getSession();
    if (!session || s.readOnly || name === s.name) return;
    session.doc.transact(() => roots(session.doc).meta.set('name', name), LOCAL_ORIGIN);
  },
  setView: (recipe) => {
    set((s) => ({ view: produce(s.view, recipe) }));
    const session = getSession();
    if (session) saveView(session.key, get().view);
  },
  setTool: (tool) => set({ tool }),
  dismissReport: () => set({ report: null }),
}));

/**
 * Troca o conteúdo inteiro do documento (abrir, exemplo, novo): uma transação de carga,
 * fora do undo. Os textos e o estado do bot são zerados, e o bot gera os painéis de novo
 * no formato canônico.
 */
export function replaceDocument(session: Session, p: Project) {
  const doc = session.doc;
  const before = new Projector(doc).current;
  const after: ProjectDoc = { name: p.name, schema: p.schema, layout: { ...p.layout }, meta: p.meta, notes: p.notes, ...(p.doc ? { doc: p.doc } : {}) };
  placeNewEntities(after);
  doc.transact(() => {
    applyDiff(doc, before, after);
    for (const f of FORMATS) {
      const t = codeText(doc, f);
      if (t.length) t.delete(0, t.length);
      roots(doc).sync.delete(f);
    }
  }, LOAD_ORIGIN);
  session.undo.clear();
}

export const getProject = (): Project => {
  const s = useProjectStore.getState();
  return { version: 1, name: s.name, view: s.view, ...s.doc };
};

/** Texto atual de um painel (o `Y.Text` compartilhado) */
export function panelText(f: Format): string {
  const session = getSession();
  return session ? codeText(session.doc, f).toString() : '';
}

export function undo() {
  getSession()?.undo.undo();
}

export function redo() {
  getSession()?.undo.redo();
}

/** Agrupa várias edições numa única entrada de undo */
export function batch(fn: () => void) {
  const um = getSession()?.undo;
  if (!um) return fn();
  um.stopCapturing();
  const prev = um.captureTimeout;
  um.captureTimeout = 1e9;
  try {
    fn();
  } finally {
    um.captureTimeout = prev;
    um.stopCapturing();
  }
}

/* ------------------------------------------------------------------ */
/* Preferências de visualização (por pessoa, por canvas)                */
/* ------------------------------------------------------------------ */

const viewKey = (k: string) => `erd:view:${k}`;

function loadView(key: string): ViewState {
  try {
    const raw = localStorage.getItem(viewKey(key));
    if (raw) return { ...defaultView(), ...(JSON.parse(raw) as Partial<ViewState>) };
  } catch {
    /* localStorage indisponível */
  }
  return defaultView();
}

function saveView(key: string, v: ViewState) {
  try {
    localStorage.setItem(viewKey(key), JSON.stringify(v));
  } catch {
    /* localStorage indisponível */
  }
}

export function storeView(key: string, v: ViewState) {
  saveView(key, v);
}

/* ------------------------------------------------------------------ */
/* Liga a projeção do documento ao store                                */
/* ------------------------------------------------------------------ */

const ORIGIN_SEEN = new Map<Format, string>();

/**
 * Conecta o store a uma sessão: a projeção do Y.Doc vira `doc`, o undo vira `canUndo`,
 * e as mudanças que o bot aplicou a partir de um texto viram o toast de mudanças.
 */
export function bindStore(session: Session): () => void {
  const projector = new Projector(session.doc);
  const toDoc = (p: ProjectDoc): Doc => ({ schema: p.schema, layout: p.layout, meta: p.meta, notes: p.notes, ...(p.doc ? { doc: p.doc } : {}) });
  const first = projector.current;
  ORIGIN_SEEN.clear();
  for (const f of FORMATS) {
    const ch = readSync(session.doc, f)?.change;
    if (ch) ORIGIN_SEEN.set(f, ch.id);
  }
  useProjectStore.setState({
    name: first.name,
    doc: toDoc(first),
    view: loadView(session.key),
    rev: 1,
    lastOrigin: 'load',
    report: null,
    loaded: true,
    canUndo: false,
    canRedo: false,
    readOnly: session.readOnly,
  });

  const onTx = (tr: Y.Transaction) => {
    const changed = projector.update(tr);
    const origin: Origin =
      tr.origin === LOCAL_ORIGIN
        ? (pendingOrigin ?? 'canvas')
        : tr.origin instanceof Y.UndoManager
          ? 'history'
          : tr.origin === LOAD_ORIGIN
            ? 'load'
            : isBotOrigin(tr.origin)
              ? (tr.origin.format ?? 'remote')
              : 'remote';
    const patch: Partial<State> = {};
    if (changed) {
      const p = projector.current;
      const s = useProjectStore.getState();
      if (p.name !== s.name) patch.name = p.name;
      const d = toDoc(p);
      if (d.schema !== s.doc.schema || d.layout !== s.doc.layout || d.meta !== s.doc.meta || d.notes !== s.doc.notes || d.doc !== s.doc.doc) {
        patch.doc = d;
        patch.rev = s.rev + 1;
        patch.lastOrigin = origin;
      }
    }
    // mudanças aplicadas a partir de um texto (por qualquer pessoa): toast com a lista
    for (const f of FORMATS) {
      const ch = readSync(session.doc, f)?.change;
      if (ch && ORIGIN_SEEN.get(f) !== ch.id) {
        ORIGIN_SEEN.set(f, ch.id);
        patch.report = { id: ++reportSeq, origin: f, items: ch.items };
      }
    }
    if (Object.keys(patch).length) useProjectStore.setState(patch);
  };
  const onStack = () =>
    useProjectStore.setState({ canUndo: session.undo.undoStack.length > 0, canRedo: session.undo.redoStack.length > 0 });
  session.doc.on('afterTransaction', onTx);
  session.undo.on('stack-item-added', onStack);
  session.undo.on('stack-item-popped', onStack);
  session.undo.on('stack-cleared', onStack);
  return () => {
    session.doc.off('afterTransaction', onTx);
    session.undo.off('stack-item-added', onStack);
    session.undo.off('stack-item-popped', onStack);
    session.undo.off('stack-cleared', onStack);
    useProjectStore.setState({ loaded: false, doc: emptyDoc(), canUndo: false, canRedo: false });
  };
}
