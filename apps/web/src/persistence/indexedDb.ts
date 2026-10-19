import { createStore, get } from 'idb-keyval';
import type { Project } from '@erd/model/types';

/**
 * Autosave antigo (antes do Y.Doc): o `Project` inteiro em JSON na chave `current`.
 * Só é lido uma vez, na primeira abertura do modo local, para converter para o Y.Doc;
 * o `y-indexeddb` cuida da persistência daqui em diante.
 */
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
