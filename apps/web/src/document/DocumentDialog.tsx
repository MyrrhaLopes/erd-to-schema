import { Download, FileText, Loader2, X } from 'lucide-react';
import { can } from '@erd/contracts';
import { useEditorContext } from '../store/useEditorContext';
import { useProjectStore } from '../store/useProjectStore';
import { showToast } from '../store/useUi';
import { downloadDocx, useDocPreview } from './client';
import { DocumentForm } from './DocumentForm';
import { DrivePanel } from './DrivePanel';
import { useDriveProject } from './queries';
import { useDocUi } from './useDocUi';

/**
 * "Documento Word" (§9.2): o formulário (o que o SQL não preenche) com a pré-visualização ao
 * lado, e a aba Drive. O documento é sempre gerado do canvas; nada aqui edita o .docx.
 */
export function DocumentDialog() {
  const open = useDocUi((s) => s.open);
  const set = useDocUi((s) => s.set);
  const mode = useEditorContext((s) => s.mode);
  const project = useEditorContext((s) => s.project);
  const canvasId = useEditorContext((s) => s.canvasId);
  const readOnly = useProjectStore((s) => s.readOnly);
  const dp = useDriveProject(mode === 'remote' && open ? project?.id : null);
  const binding = dp.data?.bindings.find((b) => b.canvasId === canvasId) ?? null;
  const version = (binding?.lastVersion ?? 0) + 1;
  const preview = useDocPreview(!!open, version);
  if (!open) return null;
  const close = () => set({ open: null, focusTable: null });
  const remote = mode === 'remote' && !!project && !!canvasId;
  const canPublish = remote && !!binding && binding.status !== 'paused' && can(project!.role, 'drivePublish', project!.settings);
  const tab = (t: 'form' | 'drive', label: string) => (
    <button
      onClick={() => set({ open: t })}
      className={'rounded-md px-3 py-1 text-[12.5px] ' + (open === t ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-100')}
      data-testid={`doc-tab-${t}`}
    >
      {label}
    </button>
  );
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={close}>
      <div
        className="flex h-[88vh] w-full max-w-[1280px] flex-col rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Documento Word"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <FileText size={16} className="text-emerald-700" />
          <h2 className="mr-3 text-[15px] font-semibold text-slate-800">Documento Word</h2>
          {tab('form', 'Formulário')}
          {remote && tab('drive', 'Google Drive')}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void downloadDocx(version).catch((e) => showToast((e as Error).message))}
              className="flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[12.5px] hover:bg-slate-50"
              data-testid="doc-download"
            >
              <Download size={13} /> Baixar .docx
            </button>
            <button
              onClick={() => set({ open: null, review: {} })}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-emerald-800"
              data-testid="doc-review"
            >
              {canPublish ? 'Revisar e publicar' : 'Revisar'}
            </button>
            <button onClick={close} className="rounded p-1 text-slate-400 hover:bg-slate-100" title="Fechar">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,520px)_1fr]">
          <div className="overflow-y-auto border-r border-slate-200 bg-slate-50 p-4">
            {open === 'drive' && remote ? <DrivePanel project={project!} canvasId={canvasId!} /> : <DocumentForm readOnly={readOnly} review={preview?.review ?? null} />}
          </div>
          <div className="overflow-auto bg-slate-200" data-testid="doc-preview">
            {preview ? <div style={{ zoom: 0.72 }} dangerouslySetInnerHTML={{ __html: preview.html }} /> : <Loader2 className="m-4 animate-spin text-slate-400" size={16} />}
          </div>
        </div>
      </div>
    </div>
  );
}
