import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, Download, Loader2, RefreshCw, UploadCloud } from 'lucide-react';
import { can } from '@erd/contracts';
import { api, ApiError, ok } from '../api/client';
import { useEditorContext } from '../store/useEditorContext';
import { showToast } from '../store/useUi';
import { downloadDocx, useDocPreview } from './client';
import { driveKeys, useDriveConfig, useDriveProject, useServerReview } from './queries';
import { GATEWAY_WARNING, useDocUi } from './useDocUi';
import { Warning } from './DrivePanel';
import { watchJob } from './DriveButton';

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * "Revisar e publicar" (§3.1): nada vai para o Drive antes da confirmação. A tela guarda o
 * hash do que foi revisado; se o canvas mudar com ela aberta, pede para atualizar, e a API
 * só aceita publicar exatamente o hash revisado.
 */
export function ReviewDialog() {
  const review = useDocUi((s) => s.review);
  const set = useDocUi((s) => s.set);
  const mode = useEditorContext((s) => s.mode);
  const project = useEditorContext((s) => s.project);
  const canvasId = useEditorContext((s) => s.canvasId);
  const remote = mode === 'remote' && !!project && !!canvasId;
  const cfg = useDriveConfig(remote);
  const dp = useDriveProject(remote ? project!.id : null);
  const binding = dp.data?.bindings.find((b) => b.canvasId === canvasId) ?? null;
  const server = useServerReview(canvasId, remote && !!review);
  const version = (binding?.lastVersion ?? 0) + 1;
  const preview = useDocPreview(!!review, version);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (!review) setReviewed(null);
    else if (preview && reviewed === null) setReviewed(preview.hash);
  }, [review, preview, reviewed]);

  if (!review) return null;
  const close = () => set({ review: null });
  const changed = !!preview && !!reviewed && preview.hash !== reviewed;
  const canPublish =
    remote && cfg.data?.enabled && !!binding && binding.status !== 'paused' && binding.status !== 'needs_folder' && can(project!.role, 'drivePublish', project!.settings);
  const unchanged = !!binding?.fileId && preview?.hash === binding.lastContentHash;
  const r = preview?.review;

  const publish = async () => {
    if (!reviewed || !canvasId) return;
    setBusy(true);
    try {
      const res = await ok(
        api.canvases[':id'].drive.publish.$post({ param: { id: canvasId }, json: { reviewedHash: reviewed, ...(review.revertFrom ? { revertedFrom: review.revertFrom } : {}) } }),
      );
      if (res.status === 'unchanged') showToast(`Nada mudou desde a v${res.version}`);
      else if (res.jobId) {
        set({ publishing: { jobId: res.jobId, version: res.version } });
        showToast(`Publicando a v${res.version} no Drive…`);
        watchJob(canvasId, res.jobId, qc, `A publicação da v${res.version} falhou`);
      }
      close();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setReviewed(null);
        void qc.invalidateQueries({ queryKey: driveKeys.review(canvasId) });
      }
      showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const diff = server.data?.diff;
  const diffItems = diff
    ? [
        ...diff.tablesAdded.map((x) => `+ tabela ${x}`),
        ...diff.tablesRemoved.map((x) => `− tabela ${x}`),
        ...diff.columnsAdded.map((x) => `+ coluna ${x}`),
        ...diff.columnsRemoved.map((x) => `− coluna ${x}`),
        ...diff.columnsChanged.map((x) => `~ coluna ${x}`),
      ]
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={close}>
      <div
        className="flex h-[88vh] w-full max-w-[1280px] flex-col rounded-xl bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Revisar e publicar"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-[15px] font-semibold text-slate-800">{canPublish ? 'Revisar e publicar' : 'Revisar o documento'}</h2>
          {review.revertFrom && <span className="rounded bg-violet-100 px-2 py-0.5 text-[11.5px] text-violet-800">revertendo da v{review.revertFrom}</span>}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => set({ review: null, open: 'form' })}
              className="flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[12.5px] hover:bg-slate-50"
            >
              <ChevronLeft size={13} /> Voltar ao formulário
            </button>
            <button
              onClick={() => void downloadDocx(version).catch((e) => showToast((e as Error).message))}
              className="flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[12.5px] hover:bg-slate-50"
              data-testid="review-download"
            >
              <Download size={13} /> Baixar .docx
            </button>
            {canPublish && (
              <button
                disabled={busy || !preview || changed}
                onClick={() => void publish()}
                className="flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                data-testid="publish"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />} Publicar v{version} no Drive
              </button>
            )}
          </div>
        </div>
        {changed && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12.5px] text-amber-900" data-testid="review-changed">
            <AlertTriangle size={14} /> O modelo mudou desde que você abriu a revisão.
            <button onClick={() => setReviewed(preview!.hash)} className="flex items-center gap-1 rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100">
              <RefreshCw size={12} /> Atualizar revisão
            </button>
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,420px)_1fr]">
          <div className="overflow-y-auto border-r border-slate-200 p-4 text-[12.5px]" data-testid="review-summary">
            {!r ? (
              <Loader2 className="animate-spin text-slate-400" size={16} />
            ) : (
              <>
                {remote && (
                  <Sec title="Destino">
                    {binding ? (
                      <div className="space-y-1.5">
                        <div>
                          Pasta: <b>{binding.folderPath ?? binding.folderName}</b>
                        </div>
                        <div>
                          Arquivo: <b>{r.fileName}</b> · vai ser a <b>v{version}</b>
                          {binding.lastVersion > 0 && <span className="text-slate-500"> (a atual é a v{binding.lastVersion})</span>}
                        </div>
                        {unchanged && <p className="rounded bg-slate-100 px-2 py-1 text-[12px] text-slate-600">Nada mudou desde a v{binding.lastVersion}.</p>}
                        <Warning text={GATEWAY_WARNING} />
                      </div>
                    ) : (
                      <p className="text-slate-500">Nenhuma pasta do Drive escolhida para este canvas. Dá para baixar o .docx.</p>
                    )}
                  </Sec>
                )}
                <Sec title="Módulos">
                  <ul className="space-y-1.5" data-testid="review-modules">
                    {r.modules.map((m) => (
                      <li key={m.key}>
                        <div>
                          <b>{m.module}</b>
                          {m.responsibility && <span className="text-slate-600"> — {m.responsibility}</span>}
                          <span className="ml-1 text-[11px] text-slate-400">{m.note ? `descrição: nota "${m.note}"` : 'sem nota de descrição'}</span>
                        </div>
                        {m.spellings.length > 1 && <div className="text-[11px] text-amber-700">Grafias diferentes tratadas como o mesmo módulo: {m.spellings.join(' · ')}</div>}
                        <div className="text-[11.5px] text-slate-600">
                          {m.tables.length ? (
                            m.tables.map((t) => `${t.name} (${t.columns} col., ${t.relationships} rel.)`).join(', ')
                          ) : (
                            <span className="text-amber-700">nenhuma tabela</span>
                          )}
                        </div>
                      </li>
                    ))}
                    {r.otherTables.length > 0 && (
                      <li>
                        <b>Outras tabelas</b> <span className="text-[11px] text-slate-400">sem tag de módulo</span>
                        <div className="text-[11.5px] text-slate-600">{r.otherTables.map((t) => t.name).join(', ')}</div>
                      </li>
                    )}
                    {!r.modules.length && <li className="text-slate-500">Nenhuma tag de módulo. Use tags como "Módulo A — Cadastro" nas tabelas (Inspector → Tags).</li>}
                  </ul>
                  {r.conflicts.map((c) => (
                    <p key={c.tableId} className="mt-1 text-[11.5px] text-amber-700">
                      {c.tableName} está em {c.modules.join(' e ')}: entrou no {c.chosen}.
                    </p>
                  ))}
                </Sec>
                <Sec title="Derivado do modelo">
                  <p>
                    {r.counts.tables} tabelas · {r.counts.columns} colunas · {r.counts.relationships} relações · {r.counts.enums} enums
                  </p>
                  <p className="text-[11.5px] text-slate-600">
                    Convenções detectadas:{' '}
                    {r.conventions
                      .filter((c) => c.detected)
                      .map((c) => c.name)
                      .join(', ') || 'nenhuma'}
                  </p>
                  {server.data?.lastPublished && (
                    <div className="mt-1.5">
                      <div className="text-[11.5px] text-slate-500">Desde a v{server.data.lastPublished.version}:</div>
                      {diffItems.length ? (
                        <ul className="max-h-32 overflow-y-auto font-mono text-[11px] text-slate-700">
                          {diffItems.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11.5px] text-slate-600">
                          {diff?.tablesChanged.length ? `Tabelas alteradas: ${diff.tablesChanged.join(', ')}` : 'Sem mudanças de estrutura (só textos do documento, se houver).'}
                        </p>
                      )}
                    </div>
                  )}
                </Sec>
                <Sec title={`Pendências (${r.pending.length})`}>
                  {!r.pending.length ? (
                    <p className="text-emerald-700">Nada pendente.</p>
                  ) : (
                    <>
                      <p className="mb-1 text-[11.5px] text-slate-500">Dá para publicar com pendências; elas saem como "—".</p>
                      <ul className="max-h-48 space-y-0.5 overflow-y-auto" data-testid="review-pending">
                        {r.pending.slice(0, 200).map((p, i) => (
                          <li key={i}>
                            <button
                              className="text-left text-[12px] text-indigo-700 hover:underline"
                              onClick={() => set({ review: null, open: 'form', focusTable: p.tableId ?? null })}
                            >
                              {p.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </Sec>
              </>
            )}
          </div>
          <div className="overflow-auto bg-slate-200" data-testid="review-preview">
            {preview ? <div style={{ zoom: 0.72 }} dangerouslySetInnerHTML={{ __html: preview.html }} /> : <Loader2 className="m-4 animate-spin text-slate-400" size={16} />}
          </div>
        </div>
      </div>
    </div>
  );
}
