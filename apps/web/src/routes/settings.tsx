import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Loader2, X } from 'lucide-react';
import { can, type EmailPrefs } from '@erd/contracts';
import { api, ApiError, ok } from '../api/client';
import { keys, sharingKeys, useAccessRequests, useMe, useMembers, useProject, useUserSettings } from '../api/queries';
import { showToast } from '../store/useUi';
import { ChangeToast } from '../ui/Dialogs';
import { Avatar, LinkSharing, MembersList, Toggle } from '../ui/sharing';
import { relTime, TopBar } from './Dashboard';
import { AuthLayout } from './auth';

function Section({ title, children, danger }: { title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className={'mb-5 rounded-xl border bg-white p-5 shadow-sm ' + (danger ? 'border-red-200' : 'border-slate-200')}>
      <h2 className={'mb-3 text-[14px] font-semibold ' + (danger ? 'text-red-700' : 'text-slate-800')}>{title}</h2>
      {children}
    </section>
  );
}

const errMsg = (e: unknown) => (e as Error).message;

function AccessRequests({ projectId, highlight }: { projectId: string; highlight?: string }) {
  const q = useAccessRequests(projectId, true);
  const qc = useQueryClient();
  const decide = async (id: string, approve: boolean, name: string) => {
    try {
      await ok(approve ? api['access-requests'][':id'].approve.$post({ param: { id } }) : api['access-requests'][':id'].deny.$post({ param: { id } }));
      showToast(approve ? `${name} agora pode editar` : 'Pedido negado');
    } catch (e) {
      showToast(errMsg(e));
    }
    void qc.invalidateQueries({ queryKey: sharingKeys.requests(projectId) });
    void qc.invalidateQueries({ queryKey: sharingKeys.members(projectId) });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  if (q.isLoading) return <p className="text-[12.5px] text-slate-500">Carregando…</p>;
  if (!q.data?.length) return <p className="text-[12.5px] text-slate-500">Nenhum pedido pendente.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {q.data.map((r) => (
        <li key={r.id} className={'flex items-start gap-3 py-2.5 ' + (r.id === highlight ? '-mx-2 rounded-md bg-amber-50 px-2' : '')} data-testid="access-request">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-slate-800">
              <b>{r.requester.name}</b> <span className="text-slate-500">({r.requester.email})</span> quer editar
            </div>
            {r.message && <div className="mt-1 rounded bg-slate-50 px-2 py-1 text-[12px] italic text-slate-600">“{r.message}”</div>}
            <div className="text-[11px] text-slate-400">{relTime(r.createdAt)}</div>
          </div>
          <button onClick={() => void decide(r.id, true, r.requester.name)} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-700">
            <Check size={13} /> Aprovar
          </button>
          <button onClick={() => void decide(r.id, false, r.requester.name)} className="flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-[12px] text-slate-700 hover:bg-slate-50">
            <X size={13} /> Negar
          </button>
        </li>
      ))}
    </ul>
  );
}

function DangerZone({ projectId, name }: { projectId: string; name: string }) {
  const members = useMembers(projectId);
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [to, setTo] = useState('');
  const others = (members.data?.members ?? []).filter((m) => m.userId !== me.data?.user?.id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-[12.5px] text-slate-700">Transferir a posse para outro membro (você vira editor).</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Novo dono" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[12.5px]">
          <option value="">Escolha um membro</option>
          {others.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
        <button
          disabled={!to}
          className="rounded-md border border-red-300 px-2.5 py-1 text-[12.5px] text-red-700 hover:bg-red-50 disabled:opacity-50"
          onClick={async () => {
            const m = others.find((x) => x.userId === to);
            if (!m || !confirm(`Transferir "${name}" para ${m.name}?`)) return;
            try {
              await ok(api.projects[':id'].transfer.$post({ param: { id: projectId }, json: { userId: to } }));
              showToast(`${m.name} agora é o dono`);
              void qc.invalidateQueries({ queryKey: keys.project(projectId) });
              void qc.invalidateQueries({ queryKey: sharingKeys.members(projectId) });
            } catch (e) {
              showToast(errMsg(e));
            }
          }}
        >
          Transferir
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12.5px] text-slate-700">Excluir o projeto para todos os membros.</span>
        <button
          className="rounded-md bg-red-600 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-red-700"
          onClick={async () => {
            if (prompt(`Para excluir, digite o nome do projeto: ${name}`) !== name) return;
            try {
              await ok(api.projects[':id'].$delete({ param: { id: projectId } }));
              void qc.invalidateQueries({ queryKey: ['projects'] });
              void nav({ to: '/' });
            } catch (e) {
              showToast(errMsg(e));
            }
          }}
        >
          Excluir projeto
        </button>
      </div>
    </div>
  );
}

function RenameField({ projectId, name, disabled }: { projectId: string; name: string; disabled: boolean }) {
  const [v, setV] = useState(name);
  const qc = useQueryClient();
  useEffect(() => setV(name), [name]);
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await ok(api.projects[':id'].$patch({ param: { id: projectId }, json: { name: v.trim() } }));
          showToast('Nome salvo');
          void qc.invalidateQueries({ queryKey: keys.project(projectId) });
          void qc.invalidateQueries({ queryKey: ['projects'] });
        } catch (err) {
          showToast(errMsg(err));
        }
      }}
    >
      <input disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} aria-label="Nome do projeto" className="flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500" />
      {!disabled && <button className="rounded-md border border-slate-300 px-3 text-[13px] hover:bg-slate-50">Salvar</button>}
    </form>
  );
}

/** /p/:id/settings — membros, pedidos de acesso, link, zona de perigo */
export function ProjectSettingsPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const search = useSearch({ strict: false }) as { request?: string };
  const project = useProject(projectId);
  const nav = useNavigate();
  useEffect(() => {
    if (project.error instanceof ApiError && project.error.status === 404) void nav({ to: '/' });
  }, [project.error, nav]);
  const p = project.data;
  return (
    <div className="flex h-full flex-col bg-slate-50">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        <Link to="/p/$projectId" params={{ projectId }} className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-slate-600 hover:text-slate-900">
          <ArrowLeft size={14} /> Voltar ao projeto
        </Link>
        {!p ? (
          <p className="text-[13px] text-slate-500">{project.error ? errMsg(project.error) : 'Carregando…'}</p>
        ) : (
          <>
            <h1 className="mb-5 text-[18px] font-semibold text-slate-800">Configurações de {p.name}</h1>
            <Section title="Geral">
              <RenameField projectId={p.id} name={p.name} disabled={!can(p.role, 'rename', p.settings)} />
            </Section>
            {can(p.role, 'approveRequests', p.settings) && (
              <Section title="Pedidos de acesso">
                <AccessRequests projectId={p.id} highlight={search.request} />
              </Section>
            )}
            <Section title="Membros">
              <MembersList project={p} />
            </Section>
            <Section title="Compartilhamento">
              <LinkSharing project={p} />
            </Section>
            {can(p.role, 'delete', p.settings) && (
              <Section title="Zona de perigo" danger>
                <DangerZone projectId={p.id} name={p.name} />
              </Section>
            )}
          </>
        )}
      </main>
      <ChangeToast />
    </div>
  );
}

/** /settings — preferências de e-mail da conta */
export function UserSettingsPage() {
  const me = useMe();
  const s = useUserSettings();
  const qc = useQueryClient();
  const save = async (patch: Partial<EmailPrefs>) => {
    try {
      const r = await ok(api.me.settings.$put({ json: patch }));
      qc.setQueryData(sharingKeys.settings, r);
      showToast('Preferências salvas');
    } catch (e) {
      showToast(errMsg(e));
    }
  };
  const prefs = s.data?.emailPrefs;
  return (
    <div className="flex h-full flex-col bg-slate-50">
      <TopBar />
      <main className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto p-6">
        <h1 className="mb-5 text-[18px] font-semibold text-slate-800">Configurações da conta</h1>
        {me.data?.user && (
          <Section title="Perfil">
            <div className="flex items-center gap-3">
              <Avatar name={me.data.user.name} color={0} size={36} />
              <div>
                <div className="text-[13.5px] text-slate-800">{me.data.user.name}</div>
                <div className="text-[12px] text-slate-500">{me.data.user.email}</div>
              </div>
            </div>
          </Section>
        )}
        <Section title="Notificações por e-mail">
          <p className="mb-2 text-[12px] text-slate-500">As notificações no sininho continuam chegando; isto liga ou desliga só o e-mail.</p>
          {!prefs ? (
            <Loader2 size={16} className="animate-spin text-slate-400" />
          ) : (
            <>
              <Toggle checked={prefs.accessRequests} onChange={(v) => void save({ accessRequests: v })} label="Pedidos de acesso aos meus projetos" />
              <Toggle checked={prefs.decisions} onChange={(v) => void save({ decisions: v })} label="Respostas aos meus pedidos de acesso" />
              <Toggle checked={prefs.membership} onChange={(v) => void save({ membership: v })} label="Quando me adicionam a um projeto ou mudam meu papel" />
            </>
          )}
          <p className="mt-2 text-[11.5px] text-slate-400">Convites, confirmação de e-mail e redefinição de senha sempre são enviados.</p>
        </Section>
      </main>
      <ChangeToast />
    </div>
  );
}

/** /invite/:token — ver o convite e aceitar (com a conta do e-mail convidado) */
export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [info, setInfo] = useState<{ projectId: string; project: string; inviter: string; email: string; role: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ok(api.invitations[':token'].$get({ param: { token } }))
      .then(setInfo)
      .catch((e) => setError(errMsg(e)));
  }, [token]);
  const here = `/invite/${token}`;
  const user = me.data?.user;
  return (
    <AuthLayout title="Convite para um projeto">
      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      ) : !info || me.isLoading ? (
        <Loader2 className="mx-auto animate-spin text-slate-400" />
      ) : (
        <div className="space-y-4 text-[13px] text-slate-700">
          <p>
            <b>{info.inviter}</b> convidou <b>{info.email}</b> para {info.role === 'editor' ? 'editar' : 'visualizar'} o projeto <b>{info.project}</b>.
          </p>
          {!user ? (
            <div className="flex gap-2">
              <Link to="/signup" search={{ redirect: here }} className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-center font-medium text-white hover:bg-indigo-700">
                Criar conta
              </Link>
              <Link to="/login" search={{ redirect: here }} className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-center hover:bg-slate-50">
                Já tenho conta
              </Link>
            </div>
          ) : user.email.toLowerCase() !== info.email.toLowerCase() ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
              Você está logado como {user.email}. Entre com {info.email} para aceitar este convite.
            </p>
          ) : (
            <button
              disabled={busy}
              className="w-full rounded-md bg-indigo-600 px-3 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await ok(api.invitations[':token'].accept.$post({ param: { token } }));
                  void qc.invalidateQueries({ queryKey: ['projects'] });
                  void nav({ to: '/p/$projectId', params: { projectId: r.projectId } });
                } catch (e) {
                  setError(errMsg(e));
                  setBusy(false);
                }
              }}
            >
              Aceitar e abrir o projeto
            </button>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
