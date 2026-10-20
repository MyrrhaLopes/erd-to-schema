import { describe, expect, it } from 'vitest';
import { emails } from '../src';

describe('templates de e-mail', () => {
  it('renderizam HTML e texto, com o link', async () => {
    const e = await emails.verify({ name: 'Ana', url: 'https://app.test/api/auth/verify-email?token=abc' });
    expect(e.subject).toBe('Confirme seu e-mail');
    expect(e.html).toContain('https://app.test/api/auth/verify-email?token=abc');
    expect(e.text).toContain('Confirmar e-mail');
    expect(e.html).toMatchSnapshot();
  });

  it('a mensagem do pedido de acesso sai escapada e truncada, e o assunto não tem conteúdo do remetente', async () => {
    const msg = '<script>alert(1)</script>' + 'x'.repeat(1000);
    const e = await emails.accessRequest({ requester: 'Mallory <hack>', email: 'm@x.com', project: 'Loja', message: msg, url: 'https://app.test/p/1/settings' });
    expect(e.subject).toBe('Novo pedido de acesso de edição');
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.text.length).toBeLessThan(2000);
  });

  it('todos os templates renderizam', async () => {
    const all = await Promise.all([
      emails.resetPassword({ name: 'Ana', url: 'u' }),
      emails.invite({ inviter: 'Ana', project: 'Loja', role: 'editor', url: 'u' }),
      emails.accessDecision({ project: 'Loja', approved: true, url: 'u' }),
      emails.accessDecision({ project: 'Loja', approved: false, url: 'u', prefsUrl: 'p' }),
      emails.memberChanged({ project: 'Loja', role: 'viewer', by: 'Ana', added: true, url: 'u' }),
    ]);
    for (const e of all) expect(e.html).toContain('ERD Builder');
  });
});
