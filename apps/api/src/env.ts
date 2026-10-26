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
    EMAIL_FROM: z.string().min(3).default('EasiER <noreply@localhost>'),
    GITHUB_CLIENT_ID: opt,
    GITHUB_CLIENT_SECRET: opt,
    GOOGLE_CLIENT_ID: opt,
    GOOGLE_CLIENT_SECRET: opt,
    /** Documento Word no Drive (drive-docx-plan §2.1): chave do Picker (restrita por referrer ao APP_URL) e número do projeto no Google Cloud */
    GOOGLE_PICKER_API_KEY: opt,
    GOOGLE_PROJECT_NUMBER: opt,
    /** `fake`: Drive em memória (E2E e dev sem Google); recusado com APP_URL em HTTPS */
    DRIVE_PROVIDER: z.enum(['google', 'fake']).optional(),
    /** Fase 7: com Redis, o Hocuspocus e os eventos de permissão escalam para várias réplicas */
    REDIS_URL: z.url().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Limite de convites por usuário por hora (antiabuso, §7.2) */
    INVITES_PER_HOUR: z.coerce.number().int().positive().default(20),
    /** Limites por conta e por projeto (§6, fase 6) */
    MAX_PROJECTS_PER_USER: z.coerce.number().int().positive().default(100),
    MAX_CANVASES_PER_PROJECT: z.coerce.number().int().positive().default(20),
    MAX_MEMBERS_PER_PROJECT: z.coerce.number().int().positive().default(50),
    MAX_VERSIONS_PER_CANVAS: z.coerce.number().int().positive().default(200),
    /** Cadastros por minuto por IP (antiabuso); o e2e contra as imagens de produção sobe isso */
    AUTH_SIGNUPS_PER_MINUTE: z.coerce.number().int().positive().default(5),
    /** Requisições por minuto por pessoa (ou IP) na API, fora o login (que tem limite próprio) */
    API_RATE_PER_MINUTE: z.coerce.number().int().positive().default(600),
    /** Protege o /metrics (Prometheus); sem ele, o /metrics só responde na rede privada */
    METRICS_TOKEN: z.string().min(16).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && e.MAIL_DRIVER !== 'resend' && e.MAIL_DRIVER !== 'smtp')
      ctx.addIssue({ code: 'custom', path: ['MAIL_DRIVER'], message: 'em produção use MAIL_DRIVER=resend (ou smtp)' });
    if (e.MAIL_DRIVER === 'resend' && !e.RESEND_API_KEY) ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'obrigatório com MAIL_DRIVER=resend' });
    if (e.MAIL_DRIVER === 'smtp' && !e.SMTP_URL) ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'obrigatório com MAIL_DRIVER=smtp' });
    if (!!e.GITHUB_CLIENT_ID !== !!e.GITHUB_CLIENT_SECRET) ctx.addIssue({ code: 'custom', path: ['GITHUB_CLIENT_SECRET'], message: 'defina id e secret juntos' });
    // o Drive falso só roda fora de HTTPS (testes, dev e as imagens de produção locais do E2E)
    if (e.NODE_ENV === 'production' && e.DRIVE_PROVIDER === 'fake' && e.APP_URL.startsWith('https://'))
      ctx.addIssue({ code: 'custom', path: ['DRIVE_PROVIDER'], message: 'o Drive falso não pode rodar num domínio público (HTTPS)' });
    if (e.DRIVE_PROVIDER === 'google' && !(e.GOOGLE_CLIENT_ID && e.GOOGLE_PICKER_API_KEY && e.GOOGLE_PROJECT_NUMBER))
      ctx.addIssue({ code: 'custom', path: ['DRIVE_PROVIDER'], message: 'o Drive precisa de GOOGLE_CLIENT_ID, GOOGLE_PICKER_API_KEY e GOOGLE_PROJECT_NUMBER' });
    if (!!e.GOOGLE_CLIENT_ID !== !!e.GOOGLE_CLIENT_SECRET) ctx.addIssue({ code: 'custom', path: ['GOOGLE_CLIENT_SECRET'], message: 'defina id e secret juntos' });
  });

export type Env = z.infer<typeof EnvZ>;

/** Qual Drive usar: o falso, o do Google (com as três variáveis) ou nenhum (a funcionalidade some) */
export function driveProviderKind(e: Env): 'google' | 'fake' | null {
  if (e.DRIVE_PROVIDER === 'fake') return 'fake';
  if (e.GOOGLE_CLIENT_ID && e.GOOGLE_PICKER_API_KEY && e.GOOGLE_PROJECT_NUMBER) return 'google';
  return null;
}

const DRIVE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_PICKER_API_KEY', 'GOOGLE_PROJECT_NUMBER'] as const;

/** As variáveis que faltam para o Drive do Google (vazio com o Drive ligado): a tela e o log do boot dizem quais */
export function driveMissing(e: Env): string[] {
  if (driveProviderKind(e)) return [];
  return DRIVE_VARS.filter((k) => !e[k]);
}

/** Valida as variáveis no boot: com variável faltando, o processo cai com uma mensagem clara e o healthcheck nunca passa */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // variável definida vazia (`REDIS_URL=` no compose, por exemplo) conta como ausente
  const r = EnvZ.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== '')));
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`);
  throw new Error(`Variáveis de ambiente inválidas:\n${lines.join('\n')}`);
}
