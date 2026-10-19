/** Lê os e-mails capturados pelo Mailpit (servidor SMTP falso do dev/CI) */
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface Summary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
}

export async function latestEmail(to: string, subject?: string | RegExp, timeoutMs = 15_000): Promise<{ subject: string; text: string; html: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (r.ok) {
      const { messages } = (await r.json()) as { messages: Summary[] };
      const m = messages.find((x) => !subject || (typeof subject === 'string' ? x.Subject === subject : subject.test(x.Subject)));
      if (m) {
        const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Subject: string; Text: string; HTML: string };
        return { subject: full.Subject, text: full.Text, html: full.HTML };
      }
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`nenhum e-mail para ${to}`);
}

export const linkIn = (text: string, contains: string) => {
  const m = text.match(new RegExp(`https?://\\S*${contains}\\S*`));
  if (!m) throw new Error(`sem link com "${contains}"`);
  return m[0].replace(/[).,]+$/, '');
};

export const uniqueEmail = (name: string) => `${name}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@e2e.test`;
