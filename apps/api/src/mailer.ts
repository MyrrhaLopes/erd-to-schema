import type { Env } from './env';
import type { Logger } from './log';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Trocar de provedor depois é trocar uma classe (§7.2) */
export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

export class ResendMailer implements Mailer {
  private client: Promise<import('resend').Resend>;
  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = import('resend').then((m) => new m.Resend(apiKey));
  }
  async send(m: MailMessage) {
    const r = await (await this.client).emails.send({ from: this.from, to: m.to, subject: m.subject, html: m.html, text: m.text });
    if (r.error) throw new Error(`Resend: ${r.error.message}`);
  }
}

/** Mailpit em dev (servidor SMTP falso com interface em localhost:8025) */
export class SmtpMailer implements Mailer {
  private transport: Promise<import('nodemailer').Transporter>;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = import('nodemailer').then((m) => m.default.createTransport(url));
  }
  async send(m: MailMessage) {
    await (await this.transport).sendMail({ from: this.from, to: m.to, subject: m.subject, html: m.html, text: m.text });
  }
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly log: Logger) {}
  async send(m: MailMessage) {
    const links = [...m.text.matchAll(/https?:\/\/\S+/g)].map((x) => x[0]);
    this.log.info({ to: m.to, subject: m.subject, links }, 'e-mail (console)');
  }
}

/** Para testes: guarda as mensagens em memória */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
  last(to: string) {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

export function createMailer(env: Env, log: Logger): Mailer {
  switch (env.MAIL_DRIVER) {
    case 'resend':
      return new ResendMailer(env.RESEND_API_KEY!, env.EMAIL_FROM);
    case 'smtp':
      return new SmtpMailer(env.SMTP_URL!, env.EMAIL_FROM);
    case 'memory':
      return new MemoryMailer();
    default:
      return new ConsoleMailer(log);
  }
}
