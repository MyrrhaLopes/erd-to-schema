import type { QueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, UploadCloud } from 'lucide-react';
import { can } from '@erd/contracts';
import { api, ok } from '../api/client';
import { useEditorContext } from '../store/useEditorContext';
import { showToast } from '../store/useUi';
import { relTime } from '../routes/Dashboard';
import { useDocPreview } from './client';
import { useDriveConfig, useDriveProject } from './queries';
import { useDocUi } from './useDocUi';

/** Acompanha um job do Drive até terminar (o evento pelo WebSocket também chega) e atualiza as telas */
export function watchJob(canvasId: string, jobId: string, qc: QueryClient, failMessage: string) {
  let tries = 0;
  const tick = async () => {
    tries++;
    const r = await ok(api.canvases[':id'].drive.jobs[':jobId'].$get({ param: { id: canvasId, jobId } })).catch(() => ({ state: 'unknown' as const }));
    if (r.state === 'completed' || r.state === 'failed' || tries > 120) {
      if (useDocUi.getState().publishing?.jobId === jobId) useDocUi.getState().set({ publishing: null });
      if (r.state === 'failed') showToast(failMessage);
      for (const k of ['project', 'publications', 'review']) void qc.invalidateQueries({ queryKey: ['drive', k] });
      return;
    }
    setTimeout(() => void tick(), 1500);
  };
  setTimeout(() => void tick(), 800);
}

/**
 * "Salvar no Drive" (§9.2): aparece quando o canvas tem pasta escolhida. O ponto avisa que o
 * canvas está diferente da última publicação; ao lado, a versão atual abre o arquivo.
 */
export function DriveButton() {
  const project = useEditorContext((s) => s.project);
  const canvasId = useEditorContext((s) => s.canvasId);
  const cfg = useDriveConfig(!!project);
  const dp = useDriveProject(cfg.data?.enabled ? project?.id : null);
  const b = dp.data?.bindings.find((x) => x.canvasId === canvasId);
  const publishing = useDocUi((s) => s.publishing);
  const set = useDocUi((s) => s.set);
  const preview = useDocPreview(!!b && b.status !== 'paused', (b?.lastVersion ?? 0) + 1);
  if (!project || !b || b.status === 'paused') return null;
  const dirty = !!preview && preview.hash !== b.lastContentHash;
  const canPublish = can(project.role, 'drivePublish', project.settings);
  return (
    <div className="flex items-center">
      {canPublish && (
        <button
          onClick={() => set({ review: {} })}
          disabled={!!publishing}
          title={dirty ? 'Há mudanças não publicadas' : 'O documento no Drive está em dia'}
          className="relative flex h-8 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 text-[12.5px] text-emerald-800 hover:bg-emerald-100 disabled:opacity-70"
          data-testid="save-to-drive"
        >
          {publishing ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
          {publishing ? 'Publicando…' : 'Salvar no Drive'}
          {dirty && !publishing && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white" data-testid="drive-dirty" />}
        </button>
      )}
      {b.webViewLink && b.lastVersion > 0 && (
        <a
          href={b.webViewLink}
          target="_blank"
          rel="noreferrer"
          className="ml-1 flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-slate-500 hover:bg-slate-100"
          title="Abrir no Google Drive"
          data-testid="drive-version"
        >
          v{b.lastVersion}
          {b.lastPublishedAt && ` · ${relTime(b.lastPublishedAt)}`} <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}
