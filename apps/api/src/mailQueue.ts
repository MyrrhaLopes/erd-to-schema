import { PgBoss } from 'pg-boss';
import { emails, type EmailKind } from '@erd/emails';
import type { Logger } from './log';
import type { Mailer } from './mailer';

/** Um e-mail a enviar: o tipo do template e as props dele (renderizado só na hora do envio) */
export type EmailJob = { [K in EmailKind]: { kind: K; to: string; props: Parameters<(typeof emails)[K]>[0] } }[EmailKind];

/**
 * Envio assíncrono com retentativa (§7.2): a requisição não espera o e-mail. A rota grava
 * um job e um worker envia, com backoff em caso de falha.
 */
export interface MailQueue {
  enqueue(job: EmailJob): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function deliver(mailer: Mailer, job: EmailJob) {
  const render = emails[job.kind] as (p: unknown) => Promise<{ subject: string; html: string; text: string }>;
  const m = await render(job.props);
  await mailer.send({ to: job.to, ...m });
}

const QUEUE = 'email';

/** pg-boss: a fila roda sobre o próprio Postgres (sem Redis só para isso), no mesmo processo da API */
export class BossMailQueue implements MailQueue {
  private boss: PgBoss;
  private started = false;
  constructor(
    url: string,
    private readonly mailer: Mailer,
    private readonly log: Logger,
    private readonly opts: { retryDelay?: number; pollingIntervalSeconds?: number } = {},
  ) {
    this.boss = new PgBoss({ connectionString: url, max: 3 });
    this.boss.on('error', (e: unknown) => log.error({ err: e }, 'pg-boss'));
  }

  async start() {
    if (this.started) return;
    await this.boss.start();
    await this.boss.createQueue(QUEUE, { retryLimit: 6, retryDelay: this.opts.retryDelay ?? 10, retryBackoff: true, deleteAfterSeconds: 7 * 86400 });
    await this.boss.work<EmailJob>(QUEUE, { pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
      for (const job of jobs) {
        try {
          await deliver(this.mailer, job.data);
        } catch (e) {
          this.log.warn({ err: e, kind: job.data.kind, retry: job.retryCount }, 'falha ao enviar e-mail; vai tentar de novo');
          throw e;
        }
      }
    });
    this.started = true;
  }

  async enqueue(job: EmailJob) {
    await this.boss.send(QUEUE, job);
  }

  async stop() {
    if (this.started) await this.boss.stop({ graceful: true, timeout: 10_000 });
    this.started = false;
  }
}

/** Para testes: envia na hora (sem segurar a requisição), com algumas tentativas */
export class InlineMailQueue implements MailQueue {
  constructor(
    private readonly mailer: Mailer,
    private readonly log: Logger,
  ) {}
  async start() {}
  async stop() {}
  async enqueue(job: EmailJob) {
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await deliver(this.mailer, job);
        } catch (e) {
          this.log.warn({ err: e, attempt }, 'falha ao enviar e-mail');
          await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
        }
      }
    })();
  }
}
