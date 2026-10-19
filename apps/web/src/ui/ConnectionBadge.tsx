import { CheckCircle2, CloudOff, HardDrive, Loader2 } from 'lucide-react';
import { useEditorContext } from '../store/useEditorContext';

/** Indicador de conexão (§8.2): "Salvo", "Sincronizando…", "Offline" */
export function ConnectionBadge() {
  const c = useEditorContext((s) => s.connection);
  const base = 'mr-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';
  if (c === 'local')
    return (
      <span className={base + ' text-slate-400'} title="Modo local: salvo só neste navegador" data-testid="connection">
        <HardDrive size={12} /> Local
      </span>
    );
  if (c === 'synced')
    return (
      <span className={base + ' text-emerald-600'} data-testid="connection">
        <CheckCircle2 size={12} /> Salvo
      </span>
    );
  if (c === 'offline')
    return (
      <span className={base + ' bg-amber-50 text-amber-700'} title="Offline: as alterações serão enviadas ao reconectar. Os painéis de código sincronizam com o diagrama ao reconectar." data-testid="connection">
        <CloudOff size={12} /> Offline
      </span>
    );
  return (
    <span className={base + ' text-slate-500'} data-testid="connection">
      <Loader2 size={12} className="animate-spin" /> Sincronizando…
    </span>
  );
}
