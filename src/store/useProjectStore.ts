import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { temporal } from 'zundo';
import type { Draft } from 'immer';
import type { EntityMeta, Id, LayoutEntry, NoteBlock, Origin, Project, SchemaModel, Tool, ViewState } from '../model/types';
import { defaultView, emptyProject, placeNewEntities } from '../model/project';
import { sanitizeSchema } from '../model/schema';

/** Parte do projeto que entra no undo/redo global */
export interface Doc {
  schema: SchemaModel;
  layout: Record<Id, LayoutEntry>;
  meta: Record<Id, EntityMeta>;
  notes: NoteBlock[];
}

export interface ChangeReport {
  id: number;
  origin: Origin;
  items: string[];
}

interface State {
  name: string;
  doc: Doc;
  view: ViewState;
  rev: number;
  lastOrigin: Origin;
  report: ChangeReport | null;
  tool: Tool;
  loaded: boolean;

  commit: (recipe: (d: Draft<Doc>) => void, origin: Origin, changes?: string[]) => void;
  loadProject: (p: Project, origin?: Origin) => void;
  setName: (name: string) => void;
  setView: (recipe: (v: Draft<ViewState>) => void) => void;
  setTool: (tool: Tool) => void;
  dismissReport: () => void;
}

let reportSeq = 0;

export const useProjectStore = create<State>()(
  temporal(
    immer((set) => ({
      name: 'Novo projeto',
      doc: { schema: emptyProject().schema, layout: {}, meta: {}, notes: [] },
      view: defaultView(),
      rev: 0,
      lastOrigin: 'load' as Origin,
      report: null,
      tool: 'select' as Tool,
      loaded: false,

      commit: (recipe, origin, changes) =>
        set((s) => {
          s.lastOrigin = origin;
          recipe(s.doc);
          sanitizeSchema(s.doc.schema as SchemaModel);
          placeNewEntities(s.doc as Doc);
          s.rev += 1;
          if (changes?.length) s.report = { id: ++reportSeq, origin, items: changes };
        }),

      loadProject: (p, origin = 'load') =>
        set((s) => {
          s.lastOrigin = origin;
          s.name = p.name;
          s.view = { ...defaultView(), ...p.view };
          s.doc = { schema: p.schema, layout: p.layout, meta: p.meta, notes: p.notes };
          placeNewEntities(s.doc as Doc);
          s.rev += 1;
          s.loaded = true;
        }),

      setName: (name) => set((s) => void (s.name = name)),
      setView: (recipe) => set((s) => void recipe(s.view)),
      setTool: (tool) => set((s) => void (s.tool = tool)),
      dismissReport: () => set((s) => void (s.report = null)),
    })),
    {
      partialize: (s) => ({ doc: s.doc }),
      equality: (a, b) => a.doc === b.doc,
      limit: 200,
    },
  ),
);

export const getProject = (): Project => {
  const s = useProjectStore.getState();
  return { version: 1, name: s.name, view: s.view, ...s.doc };
};

export function undo() {
  const t = useProjectStore.temporal.getState();
  if (!t.pastStates.length) return;
  useProjectStore.setState({ lastOrigin: 'history' });
  t.undo();
  useProjectStore.setState((s) => ({ rev: s.rev + 1 }));
}

export function redo() {
  const t = useProjectStore.temporal.getState();
  if (!t.futureStates.length) return;
  useProjectStore.setState({ lastOrigin: 'history' });
  t.redo();
  useProjectStore.setState((s) => ({ rev: s.rev + 1 }));
}

/** Agrupa várias edições numa única entrada de undo (ex.: eraser) */
export function batch(fn: () => void) {
  const t = useProjectStore.temporal.getState();
  const before = useProjectStore.getState().doc;
  t.pause();
  try {
    fn();
  } finally {
    t.resume();
  }
  const after = useProjectStore.getState().doc;
  if (before !== after) {
    // registra manualmente o estado anterior como uma entrada só
    useProjectStore.temporal.setState((ts) => ({ pastStates: [...ts.pastStates, { doc: before }].slice(-200), futureStates: [] }));
  }
}
