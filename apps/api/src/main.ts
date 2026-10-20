import { serve } from '@hono/node-server';
import { loadEnv } from './env';
import { createDeps, wirePermissionEvents } from './deps';
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

// o WebSocket do Hocuspocus usa o mesmo servidor HTTP (§6.2): /collab
deps.collab?.attach(server as unknown as import('node:http').Server);
const unlisten = await wirePermissionEvents(deps);
// a fila de e-mails roda no mesmo processo (um worker pg-boss)
await deps.mail.start();

installShutdown(
  deps.log,
  [
    // 1. para de aceitar conexões novas (as abertas seguem até o passo 2)
    { name: 'http', run: async () => void server.close() },
    // 2. grava os documentos pendentes e fecha os WebSockets com "reconecte"
    { name: 'collab', run: async () => deps.collab?.shutdown() },
    { name: 'events', run: () => unlisten() },
    // termina os e-mails em envio; os pendentes ficam no banco para o próximo container
    { name: 'mail', run: () => deps.mail.stop() },
    // 3. fecha o pool do Postgres
    { name: 'postgres', run: () => deps.pool.end() },
  ],
  state,
);
