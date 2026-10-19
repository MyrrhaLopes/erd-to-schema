/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from 'react';
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';

/**
 * Templates dos e-mails do sistema (§7.2). Nada de conteúdo livre do remetente no assunto;
 * a mensagem opcional de um pedido de acesso aparece escapada (o React escapa) e truncada.
 */

const APP = 'ERD Builder';

function Layout({ preview, title, children, footer }: { preview: string; title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Html lang="pt-BR">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: '#f8fafc', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
        <Container style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, margin: '32px auto', maxWidth: 520, padding: 28 }}>
          <Text style={{ color: '#4f46e5', fontSize: 13, fontWeight: 700, margin: 0 }}>{APP}</Text>
          <Heading as="h1" style={{ color: '#0f172a', fontSize: 20, margin: '12px 0 8px' }}>
            {title}
          </Heading>
          {children}
          <Hr style={{ borderColor: '#e2e8f0', margin: '24px 0 12px' }} />
          <Text style={{ color: '#94a3b8', fontSize: 11, margin: 0 }}>
            {footer ?? 'Você recebeu este e-mail porque alguém usou este endereço no ERD Builder. Se não foi você, ignore-o.'}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const P = ({ children }: { children: ReactNode }) => <Text style={{ color: '#334155', fontSize: 14, lineHeight: '22px' }}>{children}</Text>;

function Action({ href, label }: { href: string; label: string }) {
  return (
    <Section style={{ margin: '20px 0' }}>
      <Button href={href} style={{ backgroundColor: '#4f46e5', borderRadius: 8, color: '#ffffff', fontSize: 14, fontWeight: 600, padding: '10px 18px' }}>
        {label}
      </Button>
      <Text style={{ color: '#64748b', fontSize: 11, wordBreak: 'break-all' }}>Ou copie este link: {href}</Text>
    </Section>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export interface Email {
  subject: string;
  html: string;
  text: string;
}

async function build(subject: string, node: ReactNode): Promise<Email> {
  return { subject, html: await render(node), text: await render(node, { plainText: true }) };
}

const unsubscribe = (url?: string) =>
  url ? (
    <>
      Você pode desligar este tipo de e-mail em Configurações &gt; Notificações: {url}
    </>
  ) : undefined;

export const emails = {
  verify: (p: { name: string; url: string }) =>
    build(
      'Confirme seu e-mail',
      <Layout preview="Confirme seu e-mail para começar" title="Confirme seu e-mail">
        <P>Olá, {p.name}! Falta só confirmar que este endereço é seu.</P>
        <Action href={p.url} label="Confirmar e-mail" />
        <P>O link vale por 24 horas.</P>
      </Layout>,
    ),

  resetPassword: (p: { name: string; url: string }) =>
    build(
      'Redefinir senha',
      <Layout preview="Redefina sua senha" title="Redefinir senha">
        <P>Olá, {p.name}. Recebemos um pedido para redefinir a sua senha.</P>
        <Action href={p.url} label="Escolher uma nova senha" />
        <P>Se não foi você, ignore este e-mail: a senha atual continua valendo.</P>
      </Layout>,
    ),

  invite: (p: { inviter: string; project: string; role: 'editor' | 'viewer'; url: string }) =>
    build(
      'Você foi convidado para um projeto',
      <Layout preview={`${truncate(p.inviter, 60)} convidou você`} title="Convite para um projeto">
        <P>
          <b>{truncate(p.inviter, 80)}</b> convidou você para {p.role === 'editor' ? 'editar' : 'visualizar'} o projeto <b>{truncate(p.project, 120)}</b>.
        </P>
        <Action href={p.url} label="Abrir o convite" />
        <P>O convite expira em 7 dias.</P>
      </Layout>,
    ),

  accessRequest: (p: { requester: string; email: string; project: string; message?: string | null; url: string; prefsUrl?: string }) =>
    build(
      'Novo pedido de acesso de edição',
      <Layout preview={`${truncate(p.requester, 60)} pediu acesso de edição`} title="Pedido de acesso de edição" footer={unsubscribe(p.prefsUrl)}>
        <P>
          <b>{truncate(p.requester, 80)}</b> ({p.email}) pediu acesso de edição ao projeto <b>{truncate(p.project, 120)}</b>.
        </P>
        {p.message ? (
          <Text style={{ backgroundColor: '#f1f5f9', borderRadius: 8, color: '#334155', fontSize: 13, padding: 12, whiteSpace: 'pre-wrap' }}>“{truncate(p.message, 500)}”</Text>
        ) : null}
        <Action href={p.url} label="Ver o pedido" />
      </Layout>,
    ),

  accessDecision: (p: { project: string; approved: boolean; url: string; prefsUrl?: string }) =>
    build(
      p.approved ? 'Pedido de acesso aprovado' : 'Pedido de acesso negado',
      <Layout preview={p.approved ? 'Agora você pode editar' : 'Seu pedido foi negado'} title={p.approved ? 'Pedido aprovado' : 'Pedido negado'} footer={unsubscribe(p.prefsUrl)}>
        <P>
          {p.approved ? (
            <>
              Agora você pode editar o projeto <b>{truncate(p.project, 120)}</b>.
            </>
          ) : (
            <>
              O seu pedido de edição no projeto <b>{truncate(p.project, 120)}</b> foi negado. Você continua podendo visualizar.
            </>
          )}
        </P>
        <Action href={p.url} label="Abrir o projeto" />
      </Layout>,
    ),

  memberChanged: (p: { project: string; role: 'owner' | 'editor' | 'viewer'; by: string; added: boolean; url: string; prefsUrl?: string }) =>
    build(
      p.added ? 'Você foi adicionado a um projeto' : 'Seu papel num projeto mudou',
      <Layout preview={p.added ? 'Novo projeto compartilhado com você' : 'Seu papel mudou'} title={p.added ? 'Projeto compartilhado com você' : 'Seu papel mudou'} footer={unsubscribe(p.prefsUrl)}>
        <P>
          {truncate(p.by, 80)} {p.added ? 'adicionou você ao' : 'mudou o seu papel no'} projeto <b>{truncate(p.project, 120)}</b>: agora você é{' '}
          <b>{p.role === 'owner' ? 'dono' : p.role === 'editor' ? 'editor' : 'leitor'}</b>.
        </P>
        <Action href={p.url} label="Abrir o projeto" />
      </Layout>,
    ),
};

export type EmailKind = keyof typeof emails;
