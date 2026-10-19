import { serve } from '@hono/node-server';
import { loadEnv } from './env';
import { createDeps } from './deps';
import { createApp } from './app';
import { installShutdown } from './shutdown';

const env = loadEnv();
const deps = createDeps(env);
const state = { shuttingDown: false };
const app = createApp(deps, state);

// `::` cobre a rede privada do Railway (IPv6 nos ambientes antigos, IPv4 + IPv6 nos novos)
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '::' }, (info) => deps.log.info({ port: info.port }, 'servidor no ar'));
server.on('error', (e: NodeJS.ErrnoException) => {
  // máquina sem IPv6 (alguns runners de CI/sandboxes): cai para IPv4
  if (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL') server.listen(env.PORT, '0.0.0.0');
  else throw e;
});

installShutdown(
  deps.log,
  [
    { name: 'http', run: () => new Promise((r) => server.close(() => r(null))) },
    { name: 'postgres', run: () => deps.pool.end() },
  ],
  state,
);
