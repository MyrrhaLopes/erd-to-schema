import pino from 'pino';

/** Logs em JSON: dá para filtrar por level, canvasId e userId na aba de logs do Railway */
export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info') {
  return pino({ level, base: { service: 'server' }, timestamp: pino.stdTimeFunctions.isoTime });
}

export type Logger = ReturnType<typeof createLogger>;
