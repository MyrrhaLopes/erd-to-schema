import { PgBoss } from 'pg-boss';
import type { Logger } from './log';

/**
 * Uma instância pg-boss por processo, compartilhada pela fila de e-mails e pelos jobs do
 * Drive (drive-docx-plan §9.1). `start`/`stop` são idempotentes: quem chamar primeiro liga.
 */
export class SharedBoss {
  readonly boss: PgBoss;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  constructor(url: string, log: Logger) {
    this.boss = new PgBoss({ connectionString: url, max: 3 });
    this.boss.on('error', (e: unknown) => log.error({ err: e }, 'pg-boss'));
  }
  start() {
    return (this.starting ??= this.boss.start().then(() => {}));
  }
  stop() {
    if (!this.starting) return Promise.resolve();
    return (this.stopping ??= this.boss.stop({ graceful: true, timeout: 10_000 }));
  }
}

export type JobState = 'queued' | 'active' | 'completed' | 'failed' | 'unknown';

export interface JobContext {
  /** Tentativa atual (0 = primeira) e o limite: na última, a falha vira definitiva */
  retryCount: number;
  retryLimit: number;
}

export interface JobQueue<T> {
  /** Enfileira; jobs com o mesmo `key` nunca rodam ao mesmo tempo (um canvas por vez) */
  send(data: T, key: string, opts?: { startAfterSeconds?: number }): Promise<string>;
  /** Tarefa periódica (cron) que roda `fn` uma vez por disparo, em uma réplica */
  schedule(name: string, cron: string, fn: () => Promise<void>): void;
  state(id: string): Promise<JobState>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface QueueOptions {
  retryLimit: number;
  retryDelaySeconds: number;
}

/**
 * pg-boss com a política `singleton`: um job ativo por `singletonKey` (o canvas) e quantos
 * quiser na fila. Assim publicação e troca de pasta do mesmo canvas nunca rodam juntas,
 * mesmo com várias réplicas, e nada é descartado.
 */
export class BossJobQueue<T extends object> implements JobQueue<T> {
  private schedules: { name: string; cron: string; fn: () => Promise<void> }[] = [];
  private started = false;
  constructor(
    private readonly shared: SharedBoss,
    private readonly name: string,
    private readonly handler: (data: T, ctx: JobContext) => Promise<void>,
    private readonly log: Logger,
    private readonly opts: QueueOptions = { retryLimit: 5, retryDelaySeconds: 15 },
  ) {}

  async start() {
    if (this.started) return;
    await this.shared.start();
    const boss = this.shared.boss;
    await boss.createQueue(this.name, {
      policy: 'singleton',
      retryLimit: this.opts.retryLimit,
      retryDelay: this.opts.retryDelaySeconds,
      retryBackoff: true,
      deleteAfterSeconds: 7 * 86400,
    });
    await boss.work<T>(this.name, { pollingIntervalSeconds: 2 }, async (jobs) => {
      for (const job of jobs) {
        const j = job as unknown as { data: T; retryCount?: number };
        await this.handler(j.data, { retryCount: j.retryCount ?? 0, retryLimit: this.opts.retryLimit });
      }
    });
    for (const s of this.schedules) {
      const q = `${this.name}.${s.name}`;
      await boss.createQueue(q, { policy: 'short', deleteAfterSeconds: 86400 });
      await boss.schedule(q, s.cron);
      await boss.work(q, async () => {
        await s.fn().catch((err) => this.log.error({ err, schedule: s.name }, 'tarefa periódica falhou'));
      });
    }
    this.started = true;
  }

  async send(data: T, key: string, opts: { startAfterSeconds?: number } = {}) {
    const id = await this.shared.boss.send(this.name, data, { singletonKey: key, ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}) });
    if (!id) throw new Error('job não enfileirado');
    return id;
  }

  schedule(name: string, cron: string, fn: () => Promise<void>) {
    this.schedules.push({ name, cron, fn });
  }

  async state(id: string): Promise<JobState> {
    const j = (await this.shared.boss.getJobById(this.name, id)) as { state?: string } | null;
    switch (j?.state) {
      case 'created':
      case 'retry':
        return 'queued';
      case 'active':
        return 'active';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'cancelled':
        return 'failed';
      default:
        return 'unknown';
    }
  }

  async stop() {
    await this.shared.stop();
  }
}

/**
 * Para testes: roda na hora, em série por chave (como o `singletonKey`), com retentativa
 * imediata. `idle()` espera tudo terminar. As tarefas periódicas só rodam por `runSchedule`.
 */
export class InlineJobQueue<T extends object> implements JobQueue<T> {
  private chains = new Map<string, Promise<void>>();
  private states = new Map<string, JobState>();
  private schedules = new Map<string, () => Promise<void>>();
  private seq = 0;
  constructor(
    private readonly handler: (data: T, ctx: JobContext) => Promise<void>,
    private readonly log: Logger,
    private readonly opts: QueueOptions = { retryLimit: 5, retryDelaySeconds: 0 },
  ) {}
  async start() {}
  async stop() {
    await this.idle();
  }
  async send(data: T, key: string) {
    const id = `job_${++this.seq}`;
    this.states.set(id, 'queued');
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      this.states.set(id, 'active');
      for (let retryCount = 0; ; retryCount++) {
        try {
          await this.handler(data, { retryCount, retryLimit: this.opts.retryLimit });
          this.states.set(id, 'completed');
          return;
        } catch (err) {
          if (retryCount >= this.opts.retryLimit) {
            this.log.warn({ err }, 'job falhou');
            this.states.set(id, 'failed');
            return;
          }
        }
      }
    });
    this.chains.set(key, next);
    return id;
  }
  schedule(name: string, _cron: string, fn: () => Promise<void>) {
    this.schedules.set(name, fn);
  }
  async runSchedule(name: string) {
    await this.schedules.get(name)?.();
    await this.idle();
  }
  async state(id: string) {
    return this.states.get(id) ?? 'unknown';
  }
  async idle() {
    for (;;) {
      const all = [...this.chains.values()];
      await Promise.all(all);
      if ([...this.chains.values()].every((p, i) => p === all[i]) && this.chains.size === all.length) return;
    }
  }
}
