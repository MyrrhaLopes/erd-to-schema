import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FolderSync, Loader2, Lock, MinusCircle, Move, PencilLine, RefreshCcw, RotateCcw, Unplug, UserCog, XCircle } from 'lucide-react';
import { can, type DrivePublication, type ProjectDetail } from '@erd/contracts';
import { relTime } from '../routes/Dashboard';
import { showToast } from '../store/useUi';
import { restoreVersion } from '../ui/versions';
import { Warning } from './DrivePanel';
import { usePublications } from './queries';
import { GATEWAY_WARNING, useDocUi } from './useDocUi';

const who = (p: DrivePublication) => p.requestedBy?.name ?? 'automático';

function describe(p: DrivePublication): { icon: typeof CheckCircle2; text: string; tone: string } {
  switch (p.action) {
    case 'published':
      return { icon: CheckCircle2, text: `v${p.version} publicada por ${who(p)}${p.revertedFrom ? ` (reversão da v${p.revertedFrom})` : ''}`, tone: 'text-emerald-700' };
    case 'unchanged':
      return { icon: MinusCircle, text: `Nada mudou (pedido por ${who(p)})`, tone: 'text-slate-500' };
    case 'failed':
      return { icon: XCircle, text: `Falhou: ${p.error ?? 'erro desconhecido'}`, tone: 'text-red-700' };
    case 'folder_changed':
      return {
        icon: FolderSync,
        text: `Pasta trocada por ${who(p)}: ${p.previousFolderName ?? '?'} → ${p.folderName ?? '?'}${p.previousFolderName && p.oldFileDeletedAt ? ' (arquivo antigo excluído)' : p.previousFolderName ? ' (exclusão do antigo pendente)' : ''}`,
        tone: 'text-sky-700',
      };
    case 'recreated':
      return { icon: RefreshCcw, text: 'O arquivo tinha sumido do Drive e foi recriado', tone: 'text-amber-700' };
    case 'external_edit_detected':
      return { icon: PencilLine, text: `Editado pelo Google Drive por ${p.externalActor?.name ?? p.externalActor?.email ?? 'alguém'}`, tone: 'text-red-700' };
    case 'moved_externally':
      return { icon: Move, text: 'Movido no Drive; devolvido à pasta', tone: 'text-amber-700' };
    case 'relocked':
      return { icon: Lock, text: 'O bloqueio tinha sido retirado no Drive; bloqueado de novo', tone: 'text-amber-700' };
    case 'disconnected':
      return { icon: Unplug, text: `Desconectado por ${who(p)}${p.error ? ` (${p.error})` : ''}`, tone: 'text-slate-600' };
    case 'owner_transferred':
      return { icon: UserCog, text: `Projeto transferido${p.error ? `: ${p.error}` : ''}`, tone: 'text-slate-600' };
  }
}

/**
 * Histórico de publicações (§4, §7): só metadados. "Reverter" restaura a versão do canvas
 * ligada àquela publicação (a mesma restauração das versões) e abre a revisão.
 */
export function PublicationsList({ project, canvasId, onClose }: { project: ProjectDetail; canvasId: string; onClose: () => void }) {
  const q = usePublications(canvasId);
  const qc = useQueryClient();
  const canRevert = can(project.role, 'drivePublish', project.settings);
  return (
    <div>
      <div className="mb-2">
        <Warning text={GATEWAY_WARNING} />
      </div>
      {q.isLoading ? (
        <Loader2 className="animate-spin text-slate-400" size={16} />
      ) : !q.data?.length ? (
        <p className="py-4 text-center text-[12.5px] text-slate-500">Nenhuma publicação ainda.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto" data-testid="publications">
          {q.data.map((p) => {
            const d = describe(p);
            const Icon = d.icon;
            return (
              <li key={p.id} className="flex items-center gap-2 py-2" data-testid="publication-row">
                <Icon size={14} className={'shrink-0 ' + d.tone} />
                <div className="min-w-0 flex-1">
                  <div className={'text-[12.5px] ' + d.tone}>{d.text}</div>
                  <div className="text-[11px] text-slate-500">
                    {relTime(p.createdAt)}
                    {p.folderName && p.action === 'published' && ` · ${p.folderName}`}
                  </div>
                </div>
                {p.action === 'published' &&
                  canRevert &&
                  (p.canvasVersionId ? (
                    <button
                      className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50"
                      data-testid="revert"
                      onClick={async () => {
                        const msg = `O canvas volta ao estado da v${p.version} para todos (dá para desfazer com Ctrl+Z), e depois o documento é publicado como uma versão nova com esse conteúdo.\n\n${GATEWAY_WARNING}`;
                        if (!confirm(msg)) return;
                        try {
                          await restoreVersion(canvasId, { id: p.canvasVersionId!, label: `Publicação v${p.version}` });
                          void qc.invalidateQueries({ queryKey: ['versions', canvasId] });
                          onClose();
                          useDocUi.getState().set({ review: { revertFrom: p.version ?? undefined } });
                        } catch (e) {
                          showToast((e as Error).message);
                        }
                      }}
                    >
                      <RotateCcw size={12} /> Reverter
                    </button>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-slate-400" title="A versão do canvas desta publicação não existe mais">
                      <AlertTriangle size={11} /> Indisponível
                    </span>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
