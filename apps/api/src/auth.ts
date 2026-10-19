import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hash, verify } from '@node-rs/argon2';
import { accounts, sessions, users, verifications, type Db } from '@erd/db';
import { emails } from '@erd/emails';
import type { Env } from './env';
import type { Mailer } from './mailer';
import type { Logger } from './log';

/** argon2id com os parâmetros recomendados pelo OWASP (19 MiB, 2 iterações) */
const ARGON = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function createAuth(deps: { db: Db; env: Env; mailer: Mailer; log: Logger }) {
  const { db, env, mailer, log } = deps;
  // o envio não segura a requisição (e não vaza, pelo tempo de resposta, se o e-mail existe)
  const send = (to: string, mail: Promise<{ subject: string; html: string; text: string }>) =>
    void mail.then((m) => mailer.send({ to, ...m })).catch((e) => log.error({ err: e, to }, 'falha ao enviar e-mail de autenticação'));

  return betterAuth({
    appName: 'ERD Builder',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, { provider: 'pg', schema: { user: users, session: sessions, account: accounts, verification: verifications } }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: (password) => hash(password, ARGON),
        verify: ({ hash: h, password }) => verify(h, password),
      },
      sendResetPassword: async ({ user, url }) => send(user.email, emails.resetPassword({ name: user.name, url })),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => send(user.email, emails.verify({ name: user.name, url })),
    },
    socialProviders: {
      ...(env.GITHUB_CLIENT_ID ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET! } } : {}),
      ...(env.GOOGLE_CLIENT_ID ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET! } } : {}),
    },
    account: { accountLinking: { enabled: true, trustedProviders: ['github', 'google'] } },
    // limite de tentativas embutido, ligado também fora de produção nas rotas sensíveis
    rateLimit: {
      enabled: env.NODE_ENV !== 'test',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 },
        '/send-verification-email': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: env.APP_URL.startsWith('https://'),
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth['$Infer']['Session']['user'];

export const enabledProviders = (env: Env) => ({ github: !!env.GITHUB_CLIENT_ID, google: !!env.GOOGLE_CLIENT_ID });
