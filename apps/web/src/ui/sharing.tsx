import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, Link2, Loader2, Mail, Send, Trash2, UserPlus, X } from 'lucide-react';
import { can, colorOf, type AssignableRole, type Member, type ProjectDetail, type Role } from '@erd/contracts';
import { api, ok } from '../api/client';
import { keys, sharingKeys, useMe, useMembers } from '../api/queries';
import { showToast } from '../store/useUi';

export const ROLE_LABEL: Record<Role, string> = { owner: 'Dono', editor: 'Editor', viewer: 'Leitor' };

export function Avatar({ name, color, size = 26, title }: { name: string; color: number; size?: number; title?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span
      title={title ?? name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-white"
      style={{ width: size, height: size, background: colorOf(color), fontSize: size * 0.4 }}
    >
      {initials || '?'}
    </span>
  );
}

export function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={onClose}>
      <div className={'w-full rounded-xl bg-white p-5 shadow-xl ' + width} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" title="Fechar">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const errMsg = (e: unknown) => (e as Error).message;

/** Invalida tudo o que depende de quem tem acesso ao projeto */
function useRefreshSharing(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: sharingKeys.members(projectId) });
    void qc.invalidateQueries({ queryKey: sharingKeys.requests(projectId) });
    void qc.invalidateQueries({ queryKey: keys.project(projectId) });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
}

function MemberRow({ project, m, canManage, meId }: { project: ProjectDetail; m: Member; canManage: boolean; meId?: string }) {
  const refresh = useRefreshSharing(project.id);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await f();
      showToast(msg);
      refresh();
    } catch (e) {
      showToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const self = m.userId === meId;
  return (
    <li className="flex items-center gap-2.5 py-1.5" data-testid="member-row">
      <Avatar name={m.name} color={m.color} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-slate-800">
          {m.name} {self && <span className="text-slate-400">(você)</span>}
        </div>
        <div className="truncate text-[11.5px] text-slate-500">{m.email}</div>
      </div>
      {m.role === 'owner' || !canManage ? (
        <span className="text-[12px] text-slate-500">{ROLE_LABEL[m.role]}</span>
      ) : (
        <select
          aria-label={`Papel de ${m.name}`}
          disabled={busy}
          value={m.role}
          onChange={(e) =>
            void run(
              () => ok(api.projects[':id'].members[':userId'].$patch({ param: { id: project.id, userId: m.userId }, json: { role: e.target.value as AssignableRole } })),
              `${m.name} agora é ${ROLE_LABEL[e.target.value as Role].toLowerCase()}`,
            )
          }
          className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-[12px]"
        >
          <option value="editor">Editor</option>
          <option value="viewer">Leitor</option>
        </select>
      )}
      {m.role !== 'owner' && (canManage || self) && (
        <button
          disabled={busy}
          title={self ? 'Sair do projeto' : `Remover ${m.name}`}
          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
          onClick={() => {
            if (!confirm(self ? 'Sair deste projeto?' : `Remover ${m.name} do projeto?`)) return;
            void run(() => ok(api.projects[':id'].members[':userId'].$delete({ param: { id: project.id, userId: m.userId } })), self ? 'Você saiu do projeto' : `${m.name} foi removido`);
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </li>
  );
}

/** Lista de membros + convites pendentes (usada no diálogo e na página de configurações) */
export function MembersList({ project }: { project: ProjectDetail }) {
  const me = useMe();
  const members = useMembers(project.id);
  const refresh = useRefreshSharing(project.id);
  const canManage = can(project.role, 'manageMembers', project.settings);
  if (members.isLoading) return <p className="text-[12.5px] text-slate-500">Carregando…</p>;
  if (members.error) return <p className="text-[12.5px] text-red-600">{errMsg(members.error)}</p>;
  return (
    <>
      <ul className="divide-y divide-slate-100" data-testid="members">
        {members.data!.members.map((m) => (
          <MemberRow key={m.userId} project={project} m={m} canManage={canManage} meId={me.data?.user?.id} />
        ))}
      </ul>
      {!!members.data!.invitations.length && (
        <>
          <div className="mb-1 mt-3 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Convites pendentes</div>
          <ul className="divide-y divide-slate-100">
            {members.data!.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-2.5 py-1.5 text-[12.5px]" data-testid="invitation-row">
                <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <Mail size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700">{i.email}</span>
                <span className="text-slate-500">{ROLE_LABEL[i.role]}</span>
                <button
                  title="Cancelar convite"
                  className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  onClick={async () => {
                    await ok(api.projects[':id'].invitations[':invId'].$delete({ param: { id: project.id, invId: i.id } })).catch((e) => showToast(errMsg(e)));
                    refresh();
                  }}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function InviteForm({ project }: { project: ProjectDetail }) {
  const refresh = useRefreshSharing(project.id);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await ok(api.projects[':id'].members.$post({ param: { id: project.id }, json: { email: email.trim(), role } }));
      showToast(r.kind === 'member' ? `${email} agora tem acesso` : `Convite enviado para ${email}`);
      setEmail('');
      refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mb-3">
      <div className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-mail da pessoa"
          aria-label="E-mail para compartilhar"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500"
        />
        <select aria-label="Papel do convite" value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} className="rounded-md border border-slate-300 bg-white px-1.5 text-[12.5px]">
          <option value="editor">Editor</option>
          <option value="viewer">Leitor</option>
        </select>
        <button disabled={busy} className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Convidar
        </button>
      </div>
      {error && <p className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700">{error}</p>}
      <p className="mt-1.5 text-[11px] text-slate-500">Quem já tem conta entra direto; quem não tem recebe um convite por e-mail (válido por 7 dias).</p>
    </form>
  );
}

export function Toggle({ checked, onChange, label, sub, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; sub?: string; disabled?: boolean }) {
  return (
    <label className={'flex items-start gap-2.5 py-1.5 ' + (disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-indigo-600" />
      <span>
        <span className="block text-[13px] text-slate-800">{label}</span>
        {sub && <span className="block text-[11.5px] text-slate-500">{sub}</span>}
      </span>
    </label>
  );
}

/** Link de visualização e "editores podem compartilhar" (só o dono muda) */
export function LinkSharing({ project }: { project: ProjectDetail }) {
  const refresh = useRefreshSharing(project.id);
  const [copied, setCopied] = useState(false);
  const owner = can(project.role, 'changeSettings', project.settings);
  const save = async (settings: Partial<ProjectDetail['settings']>) => {
    try {
      await ok(api.projects[':id'].$patch({ param: { id: project.id }, json: { settings } }));
      refresh();
    } catch (e) {
      showToast(errMsg(e));
    }
  };
  const url = `${location.origin}/p/${project.id}`;
  return (
    <div>
      <Toggle
        disabled={!owner}
        checked={project.settings.linkSharing === 'view'}
        onChange={(v) => void save({ linkSharing: v ? 'view' : 'off' })}
        label="Qualquer pessoa logada com o link pode visualizar"
        sub="Quem entra pelo link vê o projeto como leitor e pode pedir acesso de edição."
      />
      <Toggle
        disabled={!owner}
        checked={project.settings.editorsCanShare}
        onChange={(v) => void save({ editorsCanShare: v })}
        label="Editores podem compartilhar"
        sub="Editores convidam pessoas, mudam papéis e aprovam pedidos de acesso."
      />
      <button
        className="mt-1 flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50"
        onClick={async () => {
          await navigator.clipboard?.writeText(url).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} className="text-emerald-600" /> : project.settings.linkSharing === 'view' ? <Link2 size={14} /> : <Copy size={14} />}
        {copied ? 'Link copiado' : 'Copiar link'}
      </button>
    </div>
  );
}

export function ShareDialog({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const canShare = can(project.role, 'share', project.settings);
  return (
    <Modal title={`Compartilhar “${project.name}”`} onClose={onClose}>
      {canShare ? (
        <InviteForm project={project} />
      ) : (
        <p className="mb-3 rounded-md bg-slate-50 px-2.5 py-2 text-[12px] text-slate-600">Só o dono{project.settings.editorsCanShare ? ' e os editores' : ''} pode convidar pessoas.</p>
      )}
      <div className="max-h-72 overflow-y-auto">
        <MembersList project={project} />
      </div>
      <div className="mt-4 border-t border-slate-100 pt-3">
        <LinkSharing project={project} />
      </div>
    </Modal>
  );
}

/** Faixa do modo visualização (§3): o leitor vê o projeto e pode pedir acesso de edição */
export function ViewModeBanner({ project }: { project: ProjectDetail }) {
  const refresh = useRefreshSharing(project.id);
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = project.myRequest?.status === 'pending' ? project.myRequest : null;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await ok(api.projects[':id']['access-requests'].$post({ param: { id: project.id }, json: { message: message.trim() || undefined } }));
      showToast('Pedido enviado. Você será avisado quando decidirem.');
      setAsking(false);
      setMessage('');
      refresh();
    } catch (err) {
      showToast(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 text-[12.5px] text-amber-900" data-testid="view-mode-banner">
      <Eye size={14} />
      <span>Você está no modo visualização.</span>
      {pending ? (
        <>
          <span className="text-amber-700">Pedido de edição enviado — aguardando aprovação.</span>
          <button
            className="text-amber-800 underline hover:text-amber-950"
            onClick={async () => {
              await ok(api['access-requests'][':id'].cancel.$post({ param: { id: pending.id } })).catch((e) => showToast(errMsg(e)));
              refresh();
            }}
          >
            Cancelar pedido
          </button>
        </>
      ) : (
        <button onClick={() => setAsking(true)} className="flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-amber-700">
          <Send size={12} /> Pedir acesso de edição
        </button>
      )}
      {asking && (
        <Modal title="Pedir acesso de edição" onClose={() => setAsking(false)} width="max-w-md">
          <form onSubmit={send}>
            <p className="mb-2 text-[12.5px] text-slate-600">
              O dono de <b>{project.name}</b> recebe o pedido na hora (e por e-mail).
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Mensagem (opcional): por que você precisa editar?"
              className="w-full resize-none rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setAsking(false)} className="rounded-md px-3 py-1.5 text-[13px] hover:bg-slate-100">
                Cancelar
              </button>
              <button disabled={busy} className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                Enviar pedido
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
