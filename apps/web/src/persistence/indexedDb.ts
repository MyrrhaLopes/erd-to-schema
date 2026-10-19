import { createStore, del, get, set } from 'idb-keyval';
import type { Project } from '@erd/model/types';

const store = createStore('erd-builder', 'projects');
const KEY = 'current';

export async function loadSaved(): Promise<Project | null> {
  try {
    const p = await get<Project>(KEY, store);
    return p && p.version === 1 ? p : null;
  } catch {
    return null;
  }
}

export async function saveProject(p: Project) {
  try {
    await set(KEY, p, store);
  } catch (e) {
    console.warn('autosave falhou', e);
  }
}

export async function clearSaved() {
  await del(KEY, store);
}
