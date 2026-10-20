import { Worker } from 'node:worker_threads';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ParseOutcome } from '@erd/model/formats/common';

/**
 * Execução isolada do Drizzle no servidor (§1, §13). O parse do Drizzle *executa* o código
 * do usuário, então ele roda num isolate V8 sem nenhuma API do Node (`isolated-vm`), com
 * limite de memória e de tempo, dentro de um `worker_thread`: se travar, o collab não cai.
 *
 * Plano B (sem `isolated-vm`): processos filhos com o permission model do Node
 * (`--permission`, sem fs além do bundle, sem child_process nem workers), rodando o
 * código num contexto `vm` sem `require` nem `process`, e mortos no timeout.
 */
export interface DrizzleSandbox {
  readonly kind: 'isolate' | 'process';
  parse(text: string): Promise<ParseOutcome>;
  close(): Promise<void>;
}

export interface SandboxOptions {
  /** Workers paralelos (cada um com o seu isolate) */
  size?: number;
  timeoutMs?: number;
  memoryMb?: number;
  /** Recria o isolate depois de N parses (vazamentos do código do usuário não se acumulam) */
  maxUses?: number;
  force?: 'isolate' | 'process';
  onEvent?: (e: { type: 'timeout' | 'memory' | 'crash' | 'respawn'; worker: number }) => void;
}

/** O bundle do isolate: ao lado do bundle do servidor (dist) ou no build do pacote */
export function isolateBundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'isolate.iife.js'), join(here, '../dist/isolate.iife.js')]) if (existsSync(c)) return c;
  throw new Error('bundle do sandbox não encontrado (rode o build de @erd/sandbox)');
}

const timeoutOutcome = (text: string, ms: number): ParseOutcome => ({
  ok: false,
  diagnostics: [{ from: 0, to: Math.min(1, text.length), severity: 'error', message: `Tempo esgotado (${ms} ms) — loop infinito? A execução foi interrompida.` }],
});

const errorOutcome = (text: string, message: string): ParseOutcome => ({
  ok: false,
  diagnostics: [{ from: 0, to: Math.min(1, text.length), severity: 'error', message }],
});

/* ------------------------------------------------------------------ */
/* isolated-vm dentro de worker_threads                                 */
/* ------------------------------------------------------------------ */

/** Roda no worker (CommonJS avaliado): um isolate por worker, recriado após falha ou N usos */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const ivm = require(workerData.ivmPath);
let isolate = null, context = null, fn = null, uses = 0;
function fresh() {
  try { if (isolate && !isolate.isDisposed) isolate.dispose(); } catch {}
  isolate = new ivm.Isolate({ memoryLimit: workerData.memoryMb });
  context = isolate.createContextSync();
  context.global.setSync('globalThis', context.global.derefInto());
  isolate.compileScriptSync(workerData.code).runSync(context, { timeout: 5000 });
  fn = context.global.getSync('__erdParse', { reference: true });
  uses = 0;
}
parentPort.on('message', ({ id, text, seed }) => {
  try {
    if (!isolate || isolate.isDisposed || uses >= workerData.maxUses) fresh();
    uses++;
    context.global.setSync('__seed', new ivm.ExternalCopy(seed).copyInto());
    const out = fn.applySync(undefined, [text], { timeout: workerData.timeoutMs });
    parentPort.postMessage({ id, out });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const kind = /timed out/i.test(msg) ? 'timeout' : /memory|disposed/i.test(msg) ? 'memory' : 'error';
    try { if (isolate && !isolate.isDisposed) isolate.dispose(); } catch {}
    isolate = null;
    parentPort.postMessage({ id, error: msg, kind });
  }
});
`;

interface Job {
  id: number;
  text: string;
  resolve: (o: ParseOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

class IsolatePool implements DrizzleSandbox {
  readonly kind = 'isolate' as const;
  private workers: { w: Worker; busy: Job | null; idx: number }[] = [];
  private queue: Job[] = [];
  private seq = 0;
  private closed = false;
  private readonly code: string;
  private readonly ivmPath: string;

  constructor(private readonly o: Required<Omit<SandboxOptions, 'force' | 'onEvent'>> & Pick<SandboxOptions, 'onEvent'>) {
    this.code = readFileSync(isolateBundlePath(), 'utf8');
    this.ivmPath = createRequire(import.meta.url).resolve('isolated-vm');
    for (let i = 0; i < o.size; i++) this.workers.push(this.spawn(i));
  }

  private spawn(idx: number) {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code: this.code, ivmPath: this.ivmPath, timeoutMs: this.o.timeoutMs, memoryMb: this.o.memoryMb, maxUses: this.o.maxUses },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const slot = { w, busy: null as Job | null, idx };
    w.on('message', (m: { id: number; out?: string; error?: string; kind?: string }) => {
      const job = slot.busy;
      if (!job || job.id !== m.id) return;
      clearTimeout(job.timer);
      slot.busy = null;
      if (m.out !== undefined) job.resolve(JSON.parse(m.out) as ParseOutcome);
      else if (m.kind === 'timeout') {
        this.o.onEvent?.({ type: 'timeout', worker: idx });
        job.resolve(timeoutOutcome(job.text, this.o.timeoutMs));
      } else if (m.kind === 'memory') {
        this.o.onEvent?.({ type: 'memory', worker: idx });
        job.resolve(errorOutcome(job.text, `Limite de memória (${this.o.memoryMb} MB) excedido ao executar o schema.`));
      } else job.resolve(errorOutcome(job.text, m.error ?? 'Falha no sandbox'));
      this.pump();
    });
    const fail = () => {
      if (this.closed) return;
      this.o.onEvent?.({ type: 'crash', worker: idx });
      const job = slot.busy;
      slot.busy = null;
      if (job) {
        clearTimeout(job.timer);
        job.resolve(errorOutcome(job.text, 'O sandbox do Drizzle caiu e foi reiniciado.'));
      }
      this.replace(slot);
    };
    w.on('error', fail);
    w.on('exit', (code) => code !== 0 && fail());
    return slot;
  }

  private replace(slot: { w: Worker; busy: Job | null; idx: number }) {
    void slot.w.terminate().catch(() => {});
    const i = this.workers.indexOf(slot);
    if (i >= 0 && !this.closed) {
      this.o.onEvent?.({ type: 'respawn', worker: slot.idx });
      this.workers[i] = this.spawn(slot.idx);
      this.pump();
    }
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift()!;
      slot.busy = job;
      // rede de segurança no host: o worker não respondeu nem com o timeout do isolate
      job.timer = setTimeout(() => {
        if (slot.busy !== job) return;
        slot.busy = null;
        job.resolve(timeoutOutcome(job.text, this.o.timeoutMs));
        this.replace(slot);
      }, this.o.timeoutMs + 2000);
      slot.w.postMessage({ id: job.id, text: job.text, seed: [...randomBytes(256)] });
    }
  }

  parse(text: string): Promise<ParseOutcome> {
    if (this.closed) return Promise.resolve(errorOutcome(text, 'sandbox fechado'));
    return new Promise((resolve) => {
      this.queue.push({ id: ++this.seq, text, resolve });
      this.pump();
    });
  }

  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((s) => s.w.terminate().catch(() => 0)));
  }
}

/* ------------------------------------------------------------------ */
/* Plano B: processo filho com --permission                              */
/* ------------------------------------------------------------------ */

const CHILD_SOURCE = `
const vm = require('node:vm');
const code = require('node:fs').readFileSync(process.argv[1], 'utf8');
const ctx = vm.createContext({});
vm.runInContext('globalThis.__seed = []; ' + code, ctx, { timeout: 5000 });
process.on('message', ({ id, text, seed, timeoutMs }) => {
  try {
    ctx.__seed = seed;
    const out = vm.runInContext('__erdParse(' + JSON.stringify(text) + ')', ctx, { timeout: timeoutMs });
    process.send({ id, out });
  } catch (e) {
    process.send({ id, error: String((e && e.message) || e), kind: /timed out/i.test(String(e)) ? 'timeout' : 'error' });
  }
});
`;

class ProcessPool implements DrizzleSandbox {
  readonly kind = 'process' as const;
  private child: ChildProcess | null = null;
  private pending = new Map<number, Job>();
  private seq = 0;
  private readonly bundle = isolateBundlePath();

  constructor(private readonly o: Required<Omit<SandboxOptions, 'force' | 'onEvent'>> & Pick<SandboxOptions, 'onEvent'>) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.connected) return this.child;
    const c = spawn(
      process.execPath,
      ['--permission', `--allow-fs-read=${this.bundle}`, `--max-old-space-size=${Math.max(32, this.o.memoryMb)}`, '-e', CHILD_SOURCE, this.bundle],
      // `vm` não é fronteira de segurança: quem escapar acha um `process` sem segredos no env,
      // sem fs (além do bundle), sem child_process e sem workers
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', env: {} },
    );
    c.on('message', (m: { id: number; out?: string; error?: string; kind?: string }) => {
      const job = this.pending.get(m.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(m.id);
      if (m.out !== undefined) job.resolve(JSON.parse(m.out) as ParseOutcome);
      else job.resolve(m.kind === 'timeout' ? timeoutOutcome(job.text, this.o.timeoutMs) : errorOutcome(job.text, m.error ?? 'Falha no sandbox'));
    });
    c.on('exit', () => {
      for (const job of this.pending.values()) {
        clearTimeout(job.timer);
        job.resolve(errorOutcome(job.text, 'O sandbox do Drizzle caiu e foi reiniciado.'));
      }
      this.pending.clear();
      this.child = null;
    });
    this.child = c;
    return c;
  }

  parse(text: string): Promise<ParseOutcome> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const job: Job = { id, text, resolve };
      job.timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(timeoutOutcome(text, this.o.timeoutMs));
        this.child?.kill('SIGKILL');
      }, this.o.timeoutMs + 1000);
      this.pending.set(id, job);
      this.ensure().send({ id, text, seed: [...randomBytes(256)], timeoutMs: this.o.timeoutMs });
    });
  }

  async close() {
    this.child?.kill('SIGKILL');
  }
}

function hasIsolatedVm(): boolean {
  try {
    createRequire(import.meta.url)('isolated-vm');
    return true;
  } catch {
    return false;
  }
}

export function createDrizzleSandbox(opts: SandboxOptions = {}): DrizzleSandbox {
  const o = { size: opts.size ?? 2, timeoutMs: opts.timeoutMs ?? 1500, memoryMb: opts.memoryMb ?? 64, maxUses: opts.maxUses ?? 200, onEvent: opts.onEvent };
  const kind = opts.force ?? (hasIsolatedVm() ? 'isolate' : 'process');
  return kind === 'isolate' ? new IsolatePool(o) : new ProcessPool(o);
}
