import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { History, Loader2, Lock, RotateCcw, Trash2 } from 'lucide-react';
import { can, type ProjectDetail, type Version } from '@erd/contracts';
import { applyDiff, LOCAL_ORIGIN, projectDoc, Projector } from '@erd/crdt';
import { api, ApiError, ok } from '../api/client';
import { getSession } from '../collab/session';
import { showToast } from '../store/useUi';
import { relTime } from '../routes/Dashboard';
import { Modal } from './sharing';
import { PublicationsList } from '../document/Publications';
import { useDriveConfig } from '../document/queries';

const versionsKey = (canvasId: string) => ['versions', canvasId] as const;

/**
 * Restaurar uma versão (§6.3) = calcular o diff entre o documento atual e a versão e
 * aplicá-lo como uma edição normal deste cliente. Assim a restauração chega ao vivo para
 * todos, passa pelo sync bot (os painéis acompanham) e pode ser desfeita com Ctrl+Z.
 */
export async function restoreVersion(canvasId: string, v: Pick<Version, 'id' | 'label'>) {
  const session = getSession();
  if (!session) return;
  const r = await fetch(`/api/canvases/${canvasId}/versions/${v.id}/state`, { credentials: 'include' });
  if (!r.ok) throw new ApiError(r.status, 'Não foi possível carregar a versão');
  const vdoc = new Y.Doc();
  Y.applyUpdate(vdoc, new Uint8Array(await r.arrayBuffer()));
  const target = projectDoc(vdoc);
  vdoc.destroy();
  const before = new Projector(session.doc).current;
  session.doc.transact(() => applyDiff(session.doc, before, { ...target, name: before.name }, { by: session.userId, at: Date.now() }), LOCAL_ORIGIN);
  await ok(api.canvases[':id'].versions[':vid'].restored.$post({ param: { id: canvasId, vid: v.id } }));
}

export function VersionsDialog({ project, canvasId, onClose }: { project: ProjectDetail; canvasId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: versionsKey(canvasId), queryFn: () => ok(api.canvases[':id'].versions.$get({ param: { id: canvasId } })) });
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = can(project.role, 'edit', project.settings);
  const canDelete = can(project.role, 'manageCanvases', project.settings);
  const drive = useDriveConfig();
  const [tab, setTab] = useState<'versions' | 'drive'>('versions');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    try {
      const r = await ok(api.canvases[':id'].versions.$post({ param: { id: canvasId }, json: { label: label.trim() } }));
      setLabel('');
      showToast(r.published?.status === 'queued' ? `Versão salva; publicando a v${r.published.version} no Drive…` : 'Versão salva');
      void qc.invalidateQueries({ queryKey: versionsKey(canvasId) });
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Versões deste canvas" onClose={onClose}>
      {drive.data?.enabled && (
        <div className="mb-3 flex gap-1 border-b border-slate-200">
          {(
            [
              ['versions', 'Versões do canvas'],
              ['drive', 'Publicações no Drive'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                '-mb-px border-b-2 px-3 py-1.5 text-[12.5px] ' +
                (tab === k ? 'border-indigo-600 font-medium text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700')
              }
              data-testid={`versions-tab-${k}`}
            >
              {l}
            </button>
          ))}
        </div>
      )}
      {tab === 'drive' ? (
        <PublicationsList project={project} canvasId={canvasId} onClose={onClose} />
      ) : (
        <>
          {canEdit && (
            <form onSubmit={save} className="mb-4 flex gap-2">
              <input
                required
                maxLength={120}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Nome da versão (ex.: antes da migração de pedidos)"
                aria-label="Nome da versão"
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500"
              />
              <button disabled={busy === 'save'} className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                Salvar versão
              </button>
            </form>
          )}
          <p className="mb-2 text-[11.5px] text-slate-500">
            Uma versão automática é guardada por dia. Restaurar é uma edição comum: todos veem na hora e dá para desfazer com Ctrl+Z.
          </p>
          {q.isLoading ? (
            <Loader2 className="animate-spin text-slate-400" size={16} />
          ) : !q.data?.length ? (
            <p className="py-4 text-center text-[12.5px] text-slate-500">Nenhuma versão ainda.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto" data-testid="versions">
              {q.data.map((v) => (
                <li key={v.id} className="flex items-center gap-2 py-2" data-testid="version-row">
                  {v.protected ? (
                    <span title="Versão de uma publicação no Drive: protegida (não é apagada nem conta no limite)">
                      <Lock size={14} className="shrink-0 text-emerald-600" />
                    </span>
                  ) : (
                    <History size={14} className="shrink-0 text-slate-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-slate-800">{v.label}</div>
                    <div className="text-[11px] text-slate-500">
                      {relTime(v.createdAt)} · {v.createdBy ? v.createdBy.name : 'automática'}
                    </div>
                  </div>
                  {canEdit && (
                    <button
                      disabled={!!busy}
                      className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      onClick={async () => {
                        if (!confirm(`Restaurar "${v.label}"? Dá para desfazer com Ctrl+Z.`)) return;
                        setBusy(v.id);
                        try {
                          await restoreVersion(canvasId, v);
                          showToast(`Versão "${v.label}" restaurada`);
                          onClose();
                        } catch (err) {
                          showToast((err as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      <RotateCcw size={12} /> Restaurar
                    </button>
                  )}
                  {canDelete && !v.protected && (
                    <button
                      title="Apagar versão"
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      onClick={async () => {
                        if (!confirm(`Apagar a versão "${v.label}"?`)) return;
                        await ok(api.canvases[':id'].versions[':vid'].$delete({ param: { id: canvasId, vid: v.id } })).catch((e) => showToast((e as Error).message));
                        void qc.invalidateQueries({ queryKey: versionsKey(canvasId) });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
