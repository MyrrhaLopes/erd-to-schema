import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Deps } from './context';
import { healthRoutes } from './health';
import { httpMetrics, metricsRoutes } from './metrics';
import { rateLimit } from './rateLimit';
import { meRoutes } from './routes/me';
import { projectsRoutes } from './routes/projects';
import { canvasesRoutes } from './routes/canvases';
import { accessRequestRoutes, invitationRoutes, notificationRoutes, projectSharingRoutes } from './routes/sharing';

/** As rotas da API (o tipo delas é o contrato do cliente tipado `hc<ApiType>` na web) */
export function buildApi(deps: Deps) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      const s = await deps.auth.api.getSession({ headers: c.req.raw.headers });
      c.set('user', s?.user ?? null);
      await next();
    })
    .use('*', rateLimit(deps.env.API_RATE_PER_MINUTE))
    .route('/me', meRoutes(deps))
    .route('/projects', projectsRoutes(deps))
    .route('/projects', projectSharingRoutes(deps))
    .route('/canvases', canvasesRoutes(deps))
    .route('/access-requests', accessRequestRoutes(deps))
    .route('/invitations', invitationRoutes(deps))
    .route('/notifications', notificationRoutes(deps));
}

export type ApiType = ReturnType<typeof buildApi>;

export function createApp(deps: Deps, state = { shuttingDown: false }) {
  const app = new Hono<AppEnv>();
  app.use('*', secureHeaders({ crossOriginResourcePolicy: false, contentSecurityPolicy: undefined }));
  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    httpMetrics.requests++;
    if (c.res.status >= 500) httpMetrics.errors5xx++;
    if (c.req.path !== '/healthz' && c.req.path !== '/readyz' && c.req.path !== '/metrics')
      deps.log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t0) }, 'http');
  });
  app.route('/', healthRoutes(deps, state));
  app.route('/', metricsRoutes(deps));
  // a origem pública é a única aceita em requisições que mudam estado (cookie first-party + CSRF)
  app.use('/api/*', csrf({ origin: [deps.env.APP_URL] }));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));
  app.route('/api', buildApi(deps));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    deps.log.error({ err, path: c.req.path }, 'erro inesperado');
    return c.json({ error: 'Erro interno' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Não encontrado' }, 404));
  return app;
}
