import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context';
import { httpMetrics } from './metrics';

/**
 * Limite de taxa simples em memória (janela de 1 minuto por pessoa logada, ou por IP).
 * Com uma réplica do `server` basta; com várias (fase 7), cada réplica conta a sua parte.
 */
export function rateLimit(perMinute: number): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, { start: number; n: number }>();
  let lastSweep = Date.now();
  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [k, w] of windows) if (now - w.start > 60_000) windows.delete(k);
      lastSweep = now;
    }
    const user = c.get('user');
    const key = user ? `u:${user.id}` : `ip:${c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'}`;
    let w = windows.get(key);
    if (!w || now - w.start > 60_000) windows.set(key, (w = { start: now, n: 0 }));
    if (++w.n > perMinute) {
      httpMetrics.rateLimited++;
      const retry = Math.ceil((w.start + 60_000 - now) / 1000);
      return c.json({ error: 'Muitas requisições. Tente de novo em instantes.' }, 429, { 'Retry-After': String(retry) });
    }
    await next();
  };
}
