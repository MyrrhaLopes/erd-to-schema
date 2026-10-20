import wasmUrl from 'libpg-query/wasm/libpg-query.wasm?url';
import type { Format } from '@erd/model/types';
import { usePanels } from './sync/panels';
import { panelText } from './store/useProjectStore';
import { hashText, readSync } from '@erd/sync';
import { getSession } from './collab/session';
import { parseInWorker } from './sync/parserClient';
import { useProjectStore } from './store/useProjectStore';

/**
 * Gancho estável para os testes e2e (Playwright): permite ler o estado dos painéis
 * sem depender do caminho dos módulos (que muda entre dev e build).
 */
export function installTestHooks() {
  (window as unknown as { __erd: unknown }).__erd = {
    panel: (f: Format) => {
      const p = usePanels.getState().panels[f];
      return { text: panelText(f), status: p.status, conflict: p.divergent.length > 0, diags: p.diagnostics.map((d) => d.message) };
    },
    tableNames: () => useProjectStore.getState().doc.schema.tables.map((t) => t.name),
    wasmUrl,
    awareness: () => {
      const s = getSession();
      return s ? [...s.awareness.getStates()].map(([id, st]) => ({ id, local: id === s.awareness.clientID, ...st })) : [];
    },
    syncState: (f: Format) => {
      const s = getSession();
      const st = s ? readSync(s.doc, f) : undefined;
      return st ? { status: st.status, textHash: st.textHash, localHash: hashText(panelText(f)), divergent: st.divergent.length } : null;
    },
    parse: (f: Format, text: string) => parseInWorker(f, text),
  };
}
