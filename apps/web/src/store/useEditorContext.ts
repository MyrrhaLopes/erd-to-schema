import { create } from 'zustand';
import type { ProjectDetail } from '@erd/contracts';
import type { ConnectionState } from '../collab/session';

/** De onde o editor foi aberto: o modo local ou um canvas de um projeto na nuvem */
interface EditorContext {
  mode: 'local' | 'remote';
  project: ProjectDetail | null;
  canvasId: string | null;
  connection: ConnectionState;
  set: (p: Partial<EditorContext>) => void;
}

export const useEditorContext = create<EditorContext>((set) => ({
  mode: 'local',
  project: null,
  canvasId: null,
  connection: 'local',
  set: (p) => set(p),
}));
