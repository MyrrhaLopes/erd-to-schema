import wasmUrl from 'libpg-query/wasm/libpg-query.wasm?url';
import type { Format } from '@erd/model/types';
import { usePanels } from './sync/panels';
import { panelText } from './store/useProjectStore';
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
    parse: (f: Format, text: string) => parseInWorker(f, text),
  };
}
