import type { Logger } from './log';

/**
 * SIGTERM (§15.2): o Railway manda SIGTERM ao container antigo e SIGKILL depois da janela de
 * draining. Os passos rodam em ordem — parar de aceitar conexões, gravar os documentos
 * pendentes, fechar os WebSockets com "reconecte", parar a fila e o pool — e o processo sai
 * com código 0 (para o Railway não acusar crash).
 */
export function installShutdown(log: Logger, steps: { name: string; run: () => Promise<unknown> }[], state: { shuttingDown: boolean }, timeoutMs = 25_000) {
  let started = false;
  const run = async (signal: string) => {
    if (started) return;
    started = true;
    state.shuttingDown = true;
    log.info({ signal }, 'desligando');
    const force = setTimeout(() => {
      log.error('desligamento demorou demais; saindo');
      process.exit(0);
    }, timeoutMs);
    force.unref();
    for (const s of steps) {
      try {
        await s.run();
        log.info({ step: s.name }, 'ok');
      } catch (e) {
        log.error({ err: e, step: s.name }, 'falha no desligamento');
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void run('SIGTERM'));
  process.on('SIGINT', () => void run('SIGINT'));
}
