import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, FolderOpen, Loader2, Lock, Unplug } from 'lucide-react';
import { can, type DriveBinding, type ProjectDetail } from '@erd/contracts';
import { api, authClient, ok } from '../api/client';
import { showToast } from '../store/useUi';
import { Modal, Toggle } from '../ui/sharing';
import { relTime } from '../routes/Dashboard';
import { useMe } from '../api/queries';
import { pickGoogleFolder } from './picker';
import { watchJob } from './DriveButton';
import { driveKeys, useDriveConfig, useDriveProject } from './queries';
import { GATEWAY_WARNING, OWNER_WARNING } from './useDocUi';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const AMBER = 'bg-amber-50 text-amber-900';
const STATUS: Record<DriveBinding['status'], { text: string; tone: string } | null> = {
  active: null,
  needs_reconnect: { text: 'O acesso ao Drive expirou: o dono precisa conectar de novo.', tone: AMBER },
  needs_folder: { text: 'Não foi possível gravar na pasta: o dono precisa escolher a pasta de novo.', tone: AMBER },
  transfer_pending: {
    text: 'O projeto mudou de dono. O documento segue no Drive do dono anterior até o novo dono conectar o Drive dele e escolher uma pasta.',
    tone: 'bg-sky-50 text-sky-900',
  },
  paused: { text: 'Desconectado do Drive. Escolha uma pasta para voltar a publicar.', tone: 'bg-slate-50 text-slate-700' },
};

export const Warning = ({ text, testid }: { text: string; testid?: string }) => (
  <p className="flex gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11.5px] text-amber-900" data-testid={testid}>
    <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {text}
  </p>
);

/** Seletor simples do modo fake (E2E/dev): as "pastas" do Drive em memória */
function FakePicker({ folders, onPick, onClose }: { folders: { id: string; name: string }[]; onPick: (f: { id: string; name: string }) => void; onClose: () => void }) {
  return (
    <Modal title="Escolha a pasta (Drive de teste)" onClose={onClose}>
      <ul className="divide-y divide-slate-100" data-testid="fake-picker">
        {folders.map((f) => (
          <li key={f.id}>
            <button className="flex w-full items-center gap-2 px-2 py-2 text-left text-[13px] hover:bg-slate-50" onClick={() => onPick(f)}>
              <FolderOpen size={14} className="text-slate-400" /> {f.name}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/**
 * Documento no Drive de um canvas (§2, §5, §8.1): conta conectada, pasta, status do
 * bloqueio e os avisos. Só o dono conecta, escolhe, troca e desconecta; os outros veem tudo.
 */
export function DrivePanel({ project, canvasId, canvasName }: { project: ProjectDetail; canvasId: string; canvasName?: string }) {
  const cfg = useDriveConfig();
  const q = useDriveProject(project.id);
  const me = useMe();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [fakeFolders, setFakeFolders] = useState<{ id: string; name: string }[] | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: driveKeys.project(project.id) });
    void qc.invalidateQueries({ queryKey: driveKeys.publications(canvasId) });
  };
  const isOwner = can(project.role, 'driveConfigure', project.settings);
  if (cfg.isLoading || q.isLoading) return <Loader2 size={16} className="animate-spin text-slate-400" />;
  // erro de rede ou da API não é "não configurado": mostra o motivo
  const failed = cfg.error ?? q.error;
  if (failed)
    return (
      <p className="text-[12.5px] text-red-700" data-testid="drive-error">
        Não foi possível consultar o Google Drive: {(failed as Error).message}
      </p>
    );
  if (!cfg.data?.enabled || !q.data?.enabled)
    return (
      <div className="text-[12.5px] text-slate-500" data-testid="drive-disabled">
        <p>O Google Drive não está configurado neste servidor. Ainda dá para baixar o .docx.</p>
        {!!cfg.data?.missing.length && (
          <p className="mt-1 text-[11.5px]">
            Faltam no serviço <code>server</code>:{' '}
            {cfg.data.missing.map((m) => (
              <code key={m} className="mr-1 rounded bg-slate-100 px-1">
                {m}
              </code>
            ))}
          </p>
        )}
      </div>
    );
  const d = q.data;
  const b = d.bindings.find((x) => x.canvasId === canvasId) ?? null;

  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const connect = () =>
    run('connect', async () => {
      if (cfg.data!.provider === 'fake') {
        await ok(api.projects[':id'].drive['fake-connect'].$post({ param: { id: project.id } }));
        showToast('Google Drive conectado');
        return;
      }
      await authClient.linkSocial({ provider: 'google', scopes: [DRIVE_SCOPE], callbackURL: location.href });
    });

  const choose = (folder: { id: string; name: string }) =>
    run('folder', async () => {
      if (b?.fileId && b.status !== 'paused') {
        const msg = `O documento será criado em "${folder.name}", e o arquivo em "${b.folderName}" será EXCLUÍDO DEFINITIVAMENTE (não vai para a lixeira e não pode ser recuperado pelo Drive). O histórico continua no app.\n\n${GATEWAY_WARNING}`;
        if (!confirm(msg)) return;
      }
      const r = await ok(api.canvases[':id'].drive.folder.$put({ param: { id: canvasId }, json: { folderId: folder.id } }));
      if (r.jobId) watchJob(canvasId, r.jobId, qc, 'A troca de pasta falhou; veja o histórico de publicações');
      showToast(
        r.status === 'queued' ? `Movendo o documento para "${folder.name}"…` : r.status === 'unchanged' ? 'Essa já é a pasta do documento' : `Pasta "${folder.name}" escolhida`,
      );
    });

  const pick = () =>
    run('pick', async () => {
      const t = await ok(api.projects[':id'].drive['picker-token'].$get({ param: { id: project.id } }));
      if (cfg.data!.provider === 'fake') {
        setFakeFolders(t.folders);
        return;
      }
      const f = await pickGoogleFolder(cfg.data!, t.accessToken);
      if (f) await choose(f);
    });

  const status = b ? STATUS[b.status] : null;
  return (
    <div className="space-y-3 text-[12.5px]" data-testid="drive-panel">
      {canvasName && <div className="text-[12px] font-semibold text-slate-700">{canvasName}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-600">Conta Google do dono ({d.owner.name}):</span>
        {d.account.connected ? (
          <span className="font-medium text-slate-800" data-testid="drive-account">
            {d.account.email ?? d.account.name ?? 'conectada'}
          </span>
        ) : (
          <span className="text-slate-500">não conectada</span>
        )}
        {isOwner && (
          <button
            disabled={!!busy}
            onClick={connect}
            className="ml-auto rounded-md border border-slate-300 px-2.5 py-1 text-[12px] hover:bg-slate-50 disabled:opacity-60"
            data-testid="drive-connect"
          >
            {d.account.connected ? 'Reconectar' : 'Conectar Google Drive'}
          </button>
        )}
      </div>

      {b ? (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <FolderOpen size={14} className="text-slate-400" />
            <span className="text-slate-800" data-testid="drive-folder">
              {b.folderPath ?? b.folderName}
            </span>
            {b.lock === 'locked' && (
              <span className="flex items-center gap-1 rounded bg-emerald-50 px-1.5 text-[10.5px] text-emerald-700" title="Ninguém edita pelo Drive: só o app publica">
                <Lock size={10} /> bloqueado
              </span>
            )}
            {b.lock === 'pending' && <span className="rounded bg-amber-50 px-1.5 text-[10.5px] text-amber-700">bloqueio pendente</span>}
            {isOwner && (
              <button
                disabled={!!busy}
                onClick={pick}
                className="ml-auto rounded-md border border-slate-300 px-2.5 py-1 text-[12px] hover:bg-slate-50 disabled:opacity-60"
                data-testid="drive-change-folder"
              >
                {b.status === 'paused' ? 'Escolher pasta…' : 'Trocar pasta…'}
              </button>
            )}
          </div>
          {b.webViewLink && (
            <div className="flex items-center gap-2">
              <a href={b.webViewLink} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-indigo-600 hover:underline" data-testid="drive-open">
                <ExternalLink size={12} /> Abrir no Drive
              </a>
              <span className="text-[11.5px] text-slate-500">
                {b.fileName} · v{b.lastVersion}
                {b.lastPublishedAt && ` · ${relTime(b.lastPublishedAt)}${b.lastPublishedBy ? ` por ${b.lastPublishedBy}` : ''}`}
              </span>
            </div>
          )}
          <Warning text={GATEWAY_WARNING} testid="gateway-warning" />
          {me.data?.user?.id && b.connectedUser?.id === me.data.user.id && <Warning text={OWNER_WARNING} />}
          {status && (
            <p className={'rounded-md px-2 py-1.5 text-[11.5px] ' + status.tone} data-testid="drive-status">
              {status.text}
            </p>
          )}
          {b.anomaly && !b.anomaly.startsWith('needs_') && (
            <p className="rounded-md bg-red-50 px-2 py-1.5 text-[11.5px] text-red-800" data-testid="drive-anomaly">
              {b.anomaly.startsWith('external_edit')
                ? 'O documento foi editado pelo Google Drive. A próxima publicação sobrescreve.'
                : b.anomaly.startsWith('missing')
                  ? 'O arquivo foi apagado ou está na lixeira do Drive. A próxima publicação cria outro.'
                  : 'O arquivo foi movido no Drive e voltou para a pasta configurada.'}
            </p>
          )}
          {b.pendingDeletions.map((p) => (
            <p key={p.fileId} className="rounded-md bg-amber-50 px-2 py-1.5 text-[11.5px] text-amber-900" data-testid="pending-deletion">
              {p.manual ? (
                <>
                  O arquivo antigo em "{p.folderName}" não pôde ser excluído.{' '}
                  <a className="underline" href={p.link} target="_blank" rel="noreferrer">
                    Exclua manualmente
                  </a>
                  .
                </>
              ) : (
                <>
                  O arquivo antigo em "{p.folderName}" ainda não foi excluído (tentativa {p.attempts}).
                </>
              )}
            </p>
          ))}
          {isOwner && b.status !== 'paused' && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Toggle
                checked={b.autoPublish}
                onChange={(v) => void run('auto', () => ok(api.canvases[':id'].drive.settings.$put({ param: { id: canvasId }, json: { autoPublish: v } })))}
                label="Publicar ao salvar uma versão nomeada (sem a tela de revisão)"
              />
              <button
                onClick={() => setDisconnecting(true)}
                className="ml-auto flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1 text-[12px] text-red-700 hover:bg-red-50"
              >
                <Unplug size={12} /> Desconectar…
              </button>
            </div>
          )}
        </div>
      ) : isOwner ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-3">
          <p className="mb-2 text-slate-600">Escolha uma pasta do seu Google Drive. O documento é criado lá na primeira publicação, já bloqueado para edição.</p>
          <button
            disabled={!!busy || !d.account.connected}
            onClick={pick}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            data-testid="drive-choose-folder"
          >
            Escolher pasta…
          </button>
          {!d.account.connected && <span className="ml-2 text-[11.5px] text-slate-500">Conecte o Drive primeiro.</span>}
        </div>
      ) : (
        <p className="text-slate-500">O dono do projeto ainda não escolheu uma pasta do Drive para este canvas.</p>
      )}

      {fakeFolders && (
        <FakePicker
          folders={fakeFolders}
          onClose={() => setFakeFolders(null)}
          onPick={(f) => {
            setFakeFolders(null);
            void choose(f);
          }}
        />
      )}
      {disconnecting && b && (
        <DisconnectDialog
          binding={b}
          onClose={() => setDisconnecting(false)}
          onConfirm={(deleteFile) => {
            setDisconnecting(false);
            void run('disconnect', async () => {
              const r = await ok(api.canvases[':id'].drive.$delete({ param: { id: canvasId }, query: { deleteFile: deleteFile ? 'true' : 'false' } }));
              watchJob(canvasId, r.jobId, qc, 'Não foi possível desconectar');
              showToast(deleteFile ? 'Desconectado; o arquivo está sendo excluído do Drive' : 'Desconectado; o arquivo ficou no Drive, congelado');
            });
          }}
        />
      )}
    </div>
  );
}

function DisconnectDialog({ binding, onClose, onConfirm }: { binding: DriveBinding; onClose: () => void; onConfirm: (deleteFile: boolean) => void }) {
  const [del, setDel] = useState(true);
  return (
    <Modal title="Desconectar do Google Drive" onClose={onClose}>
      <div className="space-y-2 text-[12.5px] text-slate-700">
        <label className="flex cursor-pointer gap-2">
          <input type="radio" checked={del} onChange={() => setDel(true)} className="mt-0.5 accent-red-600" />
          <span>
            <b>Excluir definitivamente</b> o documento de "{binding.folderName}" (não vai para a lixeira).
          </span>
        </label>
        <label className="flex cursor-pointer gap-2">
          <input type="radio" checked={!del} onChange={() => setDel(false)} className="mt-0.5 accent-indigo-600" />
          <span>Deixar o arquivo no Drive, bloqueado e congelado (o app não atualiza mais).</span>
        </label>
        <p className="text-[11.5px] text-slate-500">O histórico de publicações continua no app.</p>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-[12.5px] hover:bg-slate-50">
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(del)}
            className="rounded-md bg-red-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-700"
            data-testid="drive-disconnect-confirm"
          >
            Desconectar
          </button>
        </div>
      </div>
    </Modal>
  );
}
