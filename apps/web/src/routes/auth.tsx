import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Database, Loader2, MailCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { authClient } from '../api/client';
import { keys, useMe } from '../api/queries';

export function AuthLayout({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-slate-800">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-white">
            <Database size={16} />
          </span>
          <span className="text-[15px] font-semibold">ERD Builder</span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-4 text-[16px] font-semibold text-slate-800">{title}</h1>
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-[12.5px] text-slate-500">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-3 block text-[12px] font-medium text-slate-600">
      {label}
      <input {...props} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] text-slate-800 outline-none focus:border-indigo-500" />
    </label>
  );
}

export function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 py-2 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

const GithubMark = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const ErrorText = ({ error }: { error: string }) => (error ? <p className="mb-3 rounded-md bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700">{error}</p> : null);

function SocialButtons({ redirect }: { redirect: string }) {
  const me = useMe();
  const p = me.data?.providers;
  if (!p?.github && !p?.google) return null;
  return (
    <div className="mb-4 space-y-2">
      {p.github && (
        <button
          type="button"
          onClick={() => void authClient.signIn.social({ provider: 'github', callbackURL: redirect })}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 py-1.5 text-[13px] hover:bg-slate-50"
        >
          <GithubMark /> Entrar com GitHub
        </button>
      )}
      {p.google && (
        <button
          type="button"
          onClick={() => void authClient.signIn.social({ provider: 'google', callbackURL: redirect })}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 py-1.5 text-[13px] hover:bg-slate-50"
        >
          <span className="font-bold text-[#4285f4]">G</span> Entrar com Google
        </button>
      )}
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <span className="h-px flex-1 bg-slate-200" /> ou <span className="h-px flex-1 bg-slate-200" />
      </div>
    </div>
  );
}

const safeRedirect = (r?: string) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/');

export function LoginPage() {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const redirect = safeRedirect(search.redirect);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) {
      if (r.error.status === 403) {
        setUnverified(true);
        setError('Confirme seu e-mail antes de entrar. Reenviamos o link.');
      } else setError(r.error.status === 401 ? 'E-mail ou senha incorretos' : (r.error.message ?? 'Não foi possível entrar'));
      return;
    }
    await qc.invalidateQueries({ queryKey: keys.me });
    void nav({ to: redirect });
  };

  return (
    <AuthLayout
      title="Entrar"
      footer={
        <>
          Não tem conta?{' '}
          <Link to="/signup" search={{ redirect }} className="text-indigo-600 hover:underline">
            Criar conta
          </Link>{' '}
          · <Link to="/local" className="text-indigo-600 hover:underline">Usar sem conta</Link>
        </>
      }
    >
      <SocialButtons redirect={redirect} />
      <form onSubmit={submit}>
        <ErrorText error={error} />
        <Field label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Senha" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="mb-4 flex justify-between text-[12px]">
          <Link to="/forgot" className="text-indigo-600 hover:underline">
            Esqueci a senha
          </Link>
          {unverified && (
            <button type="button" className="text-indigo-600 hover:underline" onClick={() => void authClient.sendVerificationEmail({ email, callbackURL: redirect })}>
              Reenviar confirmação
            </button>
          )}
        </div>
        <Submit busy={busy}>Entrar</Submit>
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const redirect = safeRedirect(search.redirect);
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await authClient.signUp.email({ name, email, password, callbackURL: redirect });
    setBusy(false);
    if (r.error) {
      setError(r.error.message ?? 'Não foi possível criar a conta');
      return;
    }
    void nav({ to: '/check-email', search: { email } });
  };

  return (
    <AuthLayout
      title="Criar conta"
      footer={
        <>
          Já tem conta?{' '}
          <Link to="/login" search={{ redirect }} className="text-indigo-600 hover:underline">
            Entrar
          </Link>
        </>
      }
    >
      <SocialButtons redirect={redirect} />
      <form onSubmit={submit}>
        <ErrorText error={error} />
        <Field label="Nome" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Senha (mín. 8 caracteres)" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Submit busy={busy}>Criar conta</Submit>
      </form>
    </AuthLayout>
  );
}

export function CheckEmailPage() {
  const search = useSearch({ strict: false }) as { email?: string };
  return (
    <AuthLayout title="Confirme seu e-mail">
      <div className="flex flex-col items-center gap-3 text-center text-[13px] text-slate-600">
        <MailCheck size={32} className="text-indigo-500" />
        <p>
          Enviamos um link de confirmação para <b>{search.email ?? 'o seu e-mail'}</b>. Abra o link para entrar.
        </p>
        <Link to="/login" className="text-indigo-600 hover:underline">
          Voltar para o login
        </Link>
      </div>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
    setBusy(false);
    // mesma resposta exista ou não a conta
    setSent(true);
  };
  return (
    <AuthLayout title="Esqueci a senha" footer={<Link to="/login" className="text-indigo-600 hover:underline">Voltar para o login</Link>}>
      {sent ? (
        <p className="text-[13px] text-slate-600">Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha.</p>
      ) : (
        <form onSubmit={submit}>
          <Field label="E-mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Submit busy={busy}>Enviar link</Submit>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const search = useSearch({ strict: false }) as { token?: string; error?: string };
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(search.error ? 'Link inválido ou expirado. Peça outro.' : '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!search.token) return setError('Link inválido');
    setBusy(true);
    const r = await authClient.resetPassword({ newPassword: password, token: search.token });
    setBusy(false);
    if (r.error) return setError(r.error.message ?? 'Link inválido ou expirado');
    void nav({ to: '/login' });
  };
  return (
    <AuthLayout title="Nova senha">
      <form onSubmit={submit}>
        <ErrorText error={error} />
        <Field label="Nova senha" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Submit busy={busy}>Salvar senha</Submit>
      </form>
    </AuthLayout>
  );
}
