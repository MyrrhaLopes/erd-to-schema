import type { Project } from './model/types';
import { emptyProject, NOTE_H, NOTE_W } from './model/project';
import { newId } from './model/naming';
import { reconcile } from './model/reconcile';
import { columnSql } from './formats/sql/generate';
import { getProject, useProjectStore } from './store/useProjectStore';
import { startSyncEngine } from './sync/engine';
import { parseInWorker, warmupWorkers } from './sync/parserClient';
import { loadSaved, saveProject } from './persistence/indexedDb';
import { SAMPLE_NOTES, SAMPLE_SQL } from './sample';

export async function buildSampleProject(): Promise<Project> {
  const p = emptyProject('Exemplo — loja');
  const r = await parseInWorker('sql', SAMPLE_SQL);
  if (r.ok) {
    const rec = reconcile(p, r.parsed, 'sql', columnSql);
    p.schema = rec.schema;
    p.meta = rec.meta;
  }
  for (const n of SAMPLE_NOTES) {
    const id = newId('n_');
    p.notes.push({ id, ...n });
    p.layout[id] = { x: -340, y: 0, w: NOTE_W + 20, h: NOTE_H + 70 };
  }
  return p;
}

export function loadAndReset(p: Project) {
  useProjectStore.getState().loadProject(p, 'load');
  useProjectStore.temporal.getState().clear();
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

let started = false;

export async function bootstrap() {
  // StrictMode executa efeitos duas vezes em dev
  if (started) return;
  started = true;
  warmupWorkers();
  startSyncEngine();
  const saved = await loadSaved();
  loadAndReset(saved ?? (await buildSampleProject()));

  // autosave em IndexedDB (debounced)
  useProjectStore.subscribe((s, prev) => {
    if (s.doc === prev.doc && s.name === prev.name && s.view === prev.view) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveProject(getProject()), 500);
  });
  window.addEventListener('beforeunload', () => {
    clearTimeout(saveTimer);
    void saveProject(getProject());
  });
}
