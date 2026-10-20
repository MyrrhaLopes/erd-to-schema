import { useEffect, useRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Canvas, ReactFlowProvider } from '../canvas/Canvas';
import { Header } from '../ui/Header';
import { erdKind } from '../kinds/erd';
import { ChangeToast, ExportDialog, HelpDialog } from '../ui/Dialogs';
import { useUi } from '../store/useUi';
import { useProjectStore } from '../store/useProjectStore';
import { DocumentDialog } from '../document/DocumentDialog';
import { ReviewDialog } from '../document/ReviewDialog';

function Splitter() {
  const set = useUi((s) => s.set);
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const w = Math.min(Math.max(window.innerWidth - e.clientX, 320), window.innerWidth - 360);
      set({ panelWidth: w });
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [set]);
  return (
    <div
      className="w-1 shrink-0 cursor-col-resize bg-slate-200 hover:bg-indigo-300"
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        document.body.style.cursor = 'col-resize';
      }}
    />
  );
}

/** O editor de um canvas (o app original), igual nos modos local e nuvem */
const { SidePanels } = erdKind;

export function Editor({ error, banner, tabs }: { error?: string; banner?: ReactNode; tabs?: ReactNode }) {
  const loaded = useProjectStore((s) => s.loaded);
  const panelOpen = useUi((s) => s.panelOpen);
  const panelWidth = useUi((s) => s.panelWidth);

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <Header />
        {tabs}
        {banner}
        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1">
            {loaded ? (
              <Canvas />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                {error ? <span className="text-red-600">Falha ao abrir: {error}</span> : <><Loader2 className="animate-spin" size={16} /> Carregando…</>}
              </div>
            )}
            <ChangeToast />
          </main>
          {panelOpen && loaded && (
            <>
              <Splitter />
              <aside className="shrink-0" style={{ width: panelWidth }}>
                {SidePanels && <SidePanels />}
              </aside>
            </>
          )}
        </div>
      </div>
      <ExportDialog />
      <HelpDialog />
      {loaded && <DocumentDialog />}
      {loaded && <ReviewDialog />}
    </ReactFlowProvider>
  );
}
