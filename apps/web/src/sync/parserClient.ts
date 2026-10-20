import * as Comlink from 'comlink';
import type { Format } from '@erd/model/types';
import type { ParseOutcome } from '@erd/model/formats/common';
import type { ParserApi } from '../workers/parser.worker';
import type { DrizzleApi } from '../workers/drizzle.worker';

type Api = Pick<ParserApi, 'parse' | 'warmup'> | Pick<DrizzleApi, 'parse' | 'warmup'>;

class WorkerClient {
  private worker: Worker | null = null;
  private api: Comlink.Remote<Api> | null = null;
  private fresh = true;

  constructor(
    private readonly create: () => Worker,
    private readonly timeoutMs: number,
  ) {}

  private ensure() {
    if (!this.api) {
      this.worker = this.create();
      this.api = Comlink.wrap<Api>(this.worker);
      this.fresh = true;
    }
    return this.api;
  }

  kill() {
    this.worker?.terminate();
    this.worker = null;
    this.api = null;
  }

  warmup() {
    this.ensure()
      .warmup()
      .then(() => (this.fresh = false))
      .catch(() => {});
  }

  async parse(format: Format, text: string): Promise<ParseOutcome> {
    const api = this.ensure();
    // o primeiro uso inclui o carregamento do módulo (WASM/drizzle): mais folga
    const ms = this.fresh ? Math.max(this.timeoutMs, 8000) : this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ParseOutcome>((resolve) => {
      timer = setTimeout(() => {
        this.kill();
        resolve({
          ok: false,
          diagnostics: [
            { from: 0, to: Math.min(1, text.length), severity: 'error', message: `Tempo esgotado (${ms} ms) — loop infinito? O worker foi reiniciado.` },
          ],
        });
      }, ms);
    });
    try {
      const r = await Promise.race([(api.parse as (f: Format, t: string) => Promise<ParseOutcome>)(format, text), timeout]);
      this.fresh = false;
      return r;
    } catch (e) {
      return { ok: false, diagnostics: [{ from: 0, to: Math.min(1, text.length), severity: 'error', message: String((e as Error)?.message ?? e) }] };
    } finally {
      clearTimeout(timer);
    }
  }
}

const parserWorker = new WorkerClient(() => new Worker(new URL('../workers/parser.worker.ts', import.meta.url), { type: 'module' }), 5000);
const drizzleWorker = new WorkerClient(() => new Worker(new URL('../workers/drizzle.worker.ts', import.meta.url), { type: 'module' }), 1500);

export function parseInWorker(format: Format, text: string): Promise<ParseOutcome> {
  return format === 'drizzle' ? drizzleWorker.parse(format, text) : parserWorker.parse(format, text);
}

export function warmupWorkers() {
  parserWorker.warmup();
  drizzleWorker.warmup();
}
