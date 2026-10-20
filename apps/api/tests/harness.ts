import { createTestDatabase } from '@erd/db/testing';
import { createApp } from '../src/app';
import { serve } from '@hono/node-server';
import { createDeps, wirePermissionEvents } from '../src/deps';
import { loadEnv } from '../src/env';
import { MemoryMailer } from '../src/mailer';
import { createLogger } from '../src/log';
import type { Deps } from '../src/context';
import type { DriveProvider } from '../src/drive/provider';

export const APP_URL = 'http://app.test';

export async function harness({ envOverrides, ...overrides }: Partial<Deps> & { realtime?: boolean; envOverrides?: Record<string, string>; driveProvider?: DriveProvider } = {}) {
  const t = await createTestDatabase();
  const env = loadEnv({
    NODE_ENV: 'test',
    APP_URL,
    BETTER_AUTH_URL: APP_URL,
    DATABASE_URL: t.url,
    BETTER_AUTH_SECRET: 'x'.repeat(40),
    COLLAB_JWT_SECRET: 'y'.repeat(40),
    MAIL_DRIVER: 'memory',
    INVITES_PER_HOUR: '5',
    ...envOverrides,
  });
  const mailer = new MemoryMailer();
  const deps = createDeps(env, { db: t.db, pool: t.pool, mailer, log: createLogger('silent'), realtime: false, ...overrides });
  const app = createApp(deps);

  /** Sobe um servidor HTTP de verdade (com o WebSocket do collab em /collab) numa porta livre */
  async function listen() {
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as unknown as import('node:http').Server));
    });
    deps.collab?.attach(server);
    const unlisten = await wirePermissionEvents(deps);
    const port = (server.address() as import('node:net').AddressInfo).port;
    return {
      http: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/collab`,
      close: async () => {
        await unlisten();
        await deps.collab?.shutdown();
        await new Promise((r) => server.close(r));
      },
    };
  }

  /** Um navegador: guarda os cookies entre as requisições */
  function browser() {
    const jar = new Map<string, string>();
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    async function req(path: string, init: RequestInit & { json?: unknown } = {}) {
      const headers = new Headers(init.headers);
      headers.set('origin', APP_URL);
      if (jar.size) headers.set('cookie', cookie());
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const res = await app.request(path.startsWith('http') ? path : APP_URL + path, { ...init, headers, body, redirect: 'manual' });
      for (const sc of res.headers.getSetCookie()) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i);
        const v = kv.slice(i + 1);
        if (/max-age=0/i.test(sc) || v === '') jar.delete(k);
        else jar.set(k, v);
      }
      return res;
    }
    return {
      req,
      json: async <T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}) => {
        const r = await req(path, init);
        const text = await r.text();
        return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
      },
      jar,
    };
  }

  /** Cria a conta, confirma o e-mail pelo link (como a pessoa faria) e devolve o navegador logado */
  async function signup(name: string, email = `${name.toLowerCase()}@x.com`, password = 'senha-forte-123') {
    const b = browser();
    const r = await b.json('/api/auth/sign-up/email', { method: 'POST', json: { name, email, password, callbackURL: '/' } });
    if (r.status !== 200) throw new Error(`signup ${r.status} ${JSON.stringify(r.body)}`);
    const mail = await waitMail(email, 'Confirme seu e-mail');
    const link = mail?.text.match(/https?:\/\/\S+verify-email\S+/)?.[0];
    if (!link) throw new Error('sem link de verificação');
    const v = await b.req(link.replace(/[).,]+$/, ''));
    if (v.status >= 400) throw new Error(`verify ${v.status}`);
    const me = await b.json<{ user: { id: string } | null }>('/api/me');
    if (!me.body.user) throw new Error('não logou após verificar');
    return Object.assign(b, { id: me.body.user.id, email, name });
  }

  /** Os e-mails saem sem segurar a requisição: espera chegar */
  async function waitMail(to: string, subject?: string) {
    for (let i = 0; i < 200; i++) {
      const m = [...mailer.sent].reverse().find((x) => x.to === to && (!subject || x.subject === subject));
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`nenhum e-mail para ${to}${subject ? ` (${subject})` : ''}`);
  }

  return { ...t, env, deps, app, mailer, browser, signup, waitMail, listen, close: () => t.drop() };
}
