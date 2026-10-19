import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Canvas, ReactFlowProvider } from './canvas/Canvas';
import { Header } from './ui/Header';
import { CodePanel } from './ui/CodePanel';
import { ChangeToast, ExportDialog, HelpDialog } from './ui/Dialogs';
import { useUi } from './store/useUi';
import { useProjectStore } from './store/useProjectStore';
import { openLocalSession } from './collab/local';
import { activateSession, deactivateSession } from './collab/openCanvas';

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

export default function App() {
  const loaded = useProjectStore((s) => s.loaded);
  const panelOpen = useUi((s) => s.panelOpen);
  const panelWidth = useUi((s) => s.panelWidth);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    openLocalSession()
      .then((s) => {
        if (cancelled) s.destroy();
        else activateSession(s);
      })
      .catch((e) => setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
      deactivateSession();
    };
  }, []);

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1">
            {loaded ? (
              <Canvas />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                {error ? <span className="text-red-600">Falha ao iniciar: {error}</span> : <><Loader2 className="animate-spin" size={16} /> Carregando parser do Postgres…</>}
              </div>
            )}
            <ChangeToast />
          </main>
          {panelOpen && (
            <>
              <Splitter />
              <aside className="shrink-0" style={{ width: panelWidth }}>
                <CodePanel />
              </aside>
            </>
          )}
        </div>
      </div>
      <ExportDialog />
      <HelpDialog />
    </ReactFlowProvider>
  );
}
