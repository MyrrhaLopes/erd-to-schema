import { z } from 'zod';

const opt = z.string().min(1).optional();

export const EnvZ = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    /** URL pública (a do serviço `web`): links nos e-mails, origem confiável, callbacks OAuth */
    APP_URL: z.url(),
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    COLLAB_JWT_SECRET: z.string().min(32),
    MAIL_DRIVER: z.enum(['resend', 'smtp', 'console', 'memory']).default('console'),
    RESEND_API_KEY: opt,
    SMTP_URL: opt,
    EMAIL_FROM: z.string().min(3).default('ERD Builder <noreply@localhost>'),
    GITHUB_CLIENT_ID: opt,
    GITHUB_CLIENT_SECRET: opt,
    GOOGLE_CLIENT_ID: opt,
    GOOGLE_CLIENT_SECRET: opt,
    /** Fase 7: com Redis, o Hocuspocus e os eventos de permissão escalam para várias réplicas */
    REDIS_URL: z.url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Limite de convites por usuário por hora (antiabuso, §7.2) */
    INVITES_PER_HOUR: z.coerce.number().int().positive().default(20),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && e.MAIL_DRIVER !== 'resend' && e.MAIL_DRIVER !== 'smtp')
      ctx.addIssue({ code: 'custom', path: ['MAIL_DRIVER'], message: 'em produção use MAIL_DRIVER=resend (ou smtp)' });
    if (e.MAIL_DRIVER === 'resend' && !e.RESEND_API_KEY) ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'obrigatório com MAIL_DRIVER=resend' });
    if (e.MAIL_DRIVER === 'smtp' && !e.SMTP_URL) ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'obrigatório com MAIL_DRIVER=smtp' });
    if (!!e.GITHUB_CLIENT_ID !== !!e.GITHUB_CLIENT_SECRET) ctx.addIssue({ code: 'custom', path: ['GITHUB_CLIENT_SECRET'], message: 'defina id e secret juntos' });
    if (!!e.GOOGLE_CLIENT_ID !== !!e.GOOGLE_CLIENT_SECRET) ctx.addIssue({ code: 'custom', path: ['GOOGLE_CLIENT_SECRET'], message: 'defina id e secret juntos' });
  });

export type Env = z.infer<typeof EnvZ>;

/** Valida as variáveis no boot: com variável faltando, o processo cai com uma mensagem clara e o healthcheck nunca passa */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = EnvZ.safeParse(source);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`);
  throw new Error(`Variáveis de ambiente inválidas:\n${lines.join('\n')}`);
}
