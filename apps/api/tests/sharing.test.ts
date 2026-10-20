import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessRequest, Invitation, Member, Notification, ProjectDetail, Role } from '@erd/contracts';
import { BossMailQueue } from '../src/mailQueue';
import { createLogger } from '../src/log';
import type { MailMessage, Mailer } from '../src/mailer';
import { harness } from './harness';

let h: Awaited<ReturnType<typeof harness>>;
const events: { projectId: string; userId: string; role: Role | null }[] = [];
beforeAll(async () => {
  h = await harness({
    events: {
      async permissionChanged(e) {
        events.push(e);
      },
      async broadcast() {},
      async botMessage() {},
    },
  });
});
afterAll(() => h?.close());

type B = Awaited<ReturnType<typeof h.signup>>;

async function newProject(owner: B, name = 'Projeto') {
  const r = await owner.json<{ id: string; canvasId: string }>('/api/projects', { method: 'POST', json: { name } });
  expect(r.status).toBe(201);
  return r.body;
}

async function share(by: B, projectId: string, email: string, role: 'editor' | 'viewer') {
  return by.json<{ kind: 'member' | 'invitation'; userId?: string; id?: string }>(`/api/projects/${projectId}/members`, { method: 'POST', json: { email, role } });
}

const notifs = async (b: B) => (await b.json<{ items: Notification[]; unread: number }>('/api/notifications')).body;

describe('matriz de permissões', () => {
  it('owner, editor, viewer e quem não é membro: cada rota responde conforme o papel', async () => {
    const owner = await h.signup('Dona');
    const ed = await h.signup('Edi');
    const vi = await h.signup('Vivi');
    const out = await h.signup('Fora');
    const p = await newProject(owner);
    expect((await share(owner, p.id, ed.email, 'editor')).status).toBe(201);
    expect((await share(owner, p.id, vi.email, 'viewer')).status).toBe(201);

    // quem não é membro nem sabe que o projeto existe
    expect((await out.json(`/api/projects/${p.id}`)).status).toBe(404);
    expect((await out.json(`/api/canvases/${p.canvasId}/state`)).status).toBe(404);

    const expectStatus = async (b: B, path: string, init: RequestInit & { json?: unknown }, status: number) =>
      expect({ path, who: b.name, status: (await b.json(path, init)).status }).toEqual({ path, who: b.name, status });

    // ver e exportar: todos os membros
    for (const b of [owner, ed, vi]) {
      await expectStatus(b, `/api/projects/${p.id}`, {}, 200);
      await expectStatus(b, `/api/canvases/${p.canvasId}/export?format=sql`, {}, 200);
      await expectStatus(b, `/api/projects/${p.id}/members`, {}, 200);
    }
    // editar o documento: owner e editor
    await expectStatus(vi, `/api/canvases/${p.canvasId}/updates`, { method: 'POST', body: new Uint8Array([0, 0]) }, 403);
    // renomear e criar canvases: owner e editor
    await expectStatus(ed, `/api/projects/${p.id}`, { method: 'PATCH', json: { name: 'Novo nome' } }, 200);
    await expectStatus(vi, `/api/projects/${p.id}`, { method: 'PATCH', json: { name: 'x' } }, 403);
    await expectStatus(vi, `/api/projects/${p.id}/canvases`, { method: 'POST', json: { kind: 'erd', name: 'Outro' } }, 403);
    // compartilhar: só o owner (editorsCanShare desligado)
    await expectStatus(ed, `/api/projects/${p.id}/members`, { method: 'POST', json: { email: 'q@x.com', role: 'viewer' } }, 403);
    await expectStatus(vi, `/api/projects/${p.id}/members`, { method: 'POST', json: { email: 'q@x.com', role: 'viewer' } }, 403);
    await expectStatus(ed, `/api/projects/${p.id}/members/${vi.id}`, { method: 'PATCH', json: { role: 'editor' } }, 403);
    await expectStatus(ed, `/api/projects/${p.id}/access-requests`, {}, 403);
    // configurações, exclusão, transferência: só o owner
    await expectStatus(ed, `/api/projects/${p.id}`, { method: 'PATCH', json: { settings: { linkSharing: 'view' } } }, 403);
    await expectStatus(ed, `/api/projects/${p.id}/transfer`, { method: 'POST', json: { userId: ed.id } }, 403);
    await expectStatus(ed, `/api/projects/${p.id}`, { method: 'DELETE' }, 403);
    // pedir acesso: só o viewer
    await expectStatus(ed, `/api/projects/${p.id}/access-requests`, { method: 'POST', json: {} }, 403);

    // com editorsCanShare, o editor passa a compartilhar e aprovar
    await expectStatus(owner, `/api/projects/${p.id}`, { method: 'PATCH', json: { settings: { editorsCanShare: true } } }, 200);
    await expectStatus(ed, `/api/projects/${p.id}/access-requests`, {}, 200);
    expect((await share(ed, p.id, 'conv@x.com', 'viewer')).status).toBe(201);
    // ...mas não mexe no dono
    await expectStatus(ed, `/api/projects/${p.id}/members/${owner.id}`, { method: 'PATCH', json: { role: 'viewer' } }, 422);
    await expectStatus(ed, `/api/projects/${p.id}/members/${owner.id}`, { method: 'DELETE' }, 422);
  });

  it('o link de visualização dá acesso de viewer a qualquer conta logada (e nada mais)', async () => {
    const owner = await h.signup('Lina');
    const other = await h.signup('Leo');
    const p = await newProject(owner);
    expect((await other.json(`/api/projects/${p.id}`)).status).toBe(404);
    await owner.json(`/api/projects/${p.id}`, { method: 'PATCH', json: { settings: { linkSharing: 'view' } } });
    const d = await other.json<ProjectDetail>(`/api/projects/${p.id}`);
    expect(d.status).toBe(200);
    expect(d.body.role).toBe('viewer');
    expect((await other.json(`/api/canvases/${p.canvasId}/updates`, { method: 'POST', body: new Uint8Array([0, 0]) })).status).toBe(403);
    // não aparece na lista dele (não é membro)
    expect((await other.json<unknown[]>('/api/projects')).body).toEqual([]);
    // sem conta, nada
    expect((await h.browser().json(`/api/projects/${p.id}`)).status).toBe(401);
  });
});

describe('membros e convites', () => {
  it('compartilhar com quem tem conta adiciona direto, notifica e avisa o servidor de colaboração', async () => {
    const owner = await h.signup('Mara');
    const ed = await h.signup('Nico');
    const p = await newProject(owner, 'Loja');
    events.length = 0;
    const r = await share(owner, p.id, ed.email.toUpperCase(), 'editor');
    expect(r.body).toEqual({ kind: 'member', userId: ed.id });
    expect(events).toEqual([{ projectId: p.id, userId: ed.id, role: 'editor' }]);
    expect((await share(owner, p.id, ed.email, 'viewer')).status).toBe(409);
    const n = await notifs(ed);
    expect(n.unread).toBe(1);
    expect(n.items[0]).toMatchObject({ type: 'member-added', payload: { projectId: p.id, projectName: 'Loja', role: 'editor' } });
    const mail = await h.waitMail(ed.email, 'Você foi adicionado a um projeto');
    expect(mail.text).toContain(`/p/${p.id}`);
    // aparece na lista dele, com papel e cores distintas
    const list = await ed.json<{ role: Role }[]>('/api/projects');
    expect(list.body[0].role).toBe('editor');
    const { members } = (await owner.json<{ members: Member[] }>(`/api/projects/${p.id}/members`)).body;
    expect(members.map((m) => [m.name, m.role])).toEqual([
      ['Mara', 'owner'],
      ['Nico', 'editor'],
    ]);
    expect(new Set(members.map((m) => m.color)).size).toBe(2);
    // marca como lidas
    await ed.json('/api/notifications/read', { method: 'POST', json: {} });
    expect((await notifs(ed)).unread).toBe(0);
  });

  it('convite por e-mail para quem não tem conta: link de uso único, só para aquele e-mail', async () => {
    const owner = await h.signup('Olga');
    const p = await newProject(owner, 'Blog');
    const r = await share(owner, p.id, 'novata@x.com', 'editor');
    expect(r.body.kind).toBe('invitation');
    const mail = await h.waitMail('novata@x.com');
    expect(mail.subject).toBe('Você foi convidado para um projeto');
    expect(mail.text).toContain('Olga');
    const token = mail.text.match(/\/invite\/([\w-]+)/)![1];
    const pend = await owner.json<{ invitations: Invitation[] }>(`/api/projects/${p.id}/members`);
    expect(pend.body.invitations.map((i) => i.email)).toEqual(['novata@x.com']);

    const info = await h.browser().json<{ project: string; email: string; role: string }>(`/api/invitations/${token}`);
    expect(info.body).toMatchObject({ project: 'Blog', email: 'novata@x.com', role: 'editor' });
    // outra conta não aceita
    const intruso = await h.signup('Intruso');
    expect((await intruso.json(`/api/invitations/${token}/accept`, { method: 'POST' })).status).toBe(403);
    // a pessoa cria a conta com o e-mail convidado e aceita
    const nova = await h.signup('Novata', 'novata@x.com');
    const ok = await nova.json<{ projectId: string }>(`/api/invitations/${token}/accept`, { method: 'POST' });
    expect(ok.body.projectId).toBe(p.id);
    expect((await nova.json<ProjectDetail>(`/api/projects/${p.id}`)).body.role).toBe('editor');
    // uso único
    expect((await nova.json(`/api/invitations/${token}/accept`, { method: 'POST' })).status).toBe(410);
    expect((await owner.json<{ invitations: Invitation[] }>(`/api/projects/${p.id}/members`)).body.invitations).toEqual([]);
    // token inventado
    expect((await h.browser().json('/api/invitations/abc')).status).toBe(404);
  });

  it('mudar papel e remover: vale na hora e o dono não perde a posse', async () => {
    const owner = await h.signup('Paula');
    const m = await h.signup('Quim');
    const p = await newProject(owner);
    await share(owner, p.id, m.email, 'viewer');
    events.length = 0;
    expect((await owner.json(`/api/projects/${p.id}/members/${m.id}`, { method: 'PATCH', json: { role: 'editor' } })).status).toBe(200);
    expect(events).toEqual([{ projectId: p.id, userId: m.id, role: 'editor' }]);
    expect((await m.json<ProjectDetail>(`/api/projects/${p.id}`)).body.role).toBe('editor');
    expect((await owner.json(`/api/projects/${p.id}/members/${m.id}`, { method: 'PATCH', json: { role: 'owner' } })).status).toBe(400);
    expect((await owner.json(`/api/projects/${p.id}/members/${owner.id}`, { method: 'DELETE' })).status).toBe(422);
    events.length = 0;
    expect((await owner.json(`/api/projects/${p.id}/members/${m.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(events).toEqual([{ projectId: p.id, userId: m.id, role: null }]);
    expect((await m.json(`/api/projects/${p.id}`)).status).toBe(404);
    expect((await notifs(m)).items[0].type).toBe('member-removed');
  });

  it('sair do projeto e transferir a posse', async () => {
    const owner = await h.signup('Rita');
    const m = await h.signup('Saulo');
    const p = await newProject(owner);
    await share(owner, p.id, m.email, 'editor');
    expect((await owner.json(`/api/projects/${p.id}/transfer`, { method: 'POST', json: { userId: m.id } })).status).toBe(200);
    expect((await m.json<ProjectDetail>(`/api/projects/${p.id}`)).body.role).toBe('owner');
    expect((await owner.json<ProjectDetail>(`/api/projects/${p.id}`)).body.role).toBe('editor');
    expect((await owner.json(`/api/projects/${p.id}/members/${owner.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await owner.json(`/api/projects/${p.id}`)).status).toBe(404);
  });

  it('limite de convites por hora (antiabuso)', async () => {
    const owner = await h.signup('Tati');
    const p = await newProject(owner);
    // INVITES_PER_HOUR=5 no harness
    for (let i = 0; i < 5; i++) expect((await share(owner, p.id, `spam${i}@x.com`, 'viewer')).status).toBe(201);
    const r = await share(owner, p.id, 'spam9@x.com', 'viewer');
    expect(r.status).toBe(429);
  });
});

describe('pedidos de acesso', () => {
  it('o viewer pede edição, o dono recebe in-app e por e-mail, aprova, e o viewer vira editor', async () => {
    const owner = await h.signup('Ursula');
    const v = await h.signup('Vitor');
    const p = await newProject(owner, 'Estoque');
    await share(owner, p.id, v.email, 'viewer');
    const r = await v.json<{ id: string }>(`/api/projects/${p.id}/access-requests`, { method: 'POST', json: { message: 'preciso ajustar a tabela de pedidos' } });
    expect(r.status).toBe(201);
    // só um pendente por pessoa
    expect((await v.json(`/api/projects/${p.id}/access-requests`, { method: 'POST', json: {} })).status).toBe(409);
    expect((await v.json<ProjectDetail>(`/api/projects/${p.id}`)).body.myRequest).toEqual({ id: r.body.id, status: 'pending' });

    const n = await notifs(owner);
    expect(n.items[0]).toMatchObject({ type: 'access-request', payload: { requestId: r.body.id, requester: 'Vitor' } });
    const mail = await h.waitMail(owner.email, 'Novo pedido de acesso de edição');
    expect(mail.text).toContain(`/p/${p.id}/settings?request=${r.body.id}`);
    expect(mail.text).toContain('preciso ajustar a tabela de pedidos');
    const list = await owner.json<AccessRequest[]>(`/api/projects/${p.id}/access-requests`);
    expect(list.body.map((x) => x.requester.name)).toEqual(['Vitor']);
    const summary = await owner.json<{ pendingRequests?: number }[]>('/api/projects');
    expect(summary.body[0].pendingRequests).toBe(1);

    // o próprio viewer não aprova o próprio pedido
    expect((await v.json(`/api/access-requests/${r.body.id}/approve`, { method: 'POST' })).status).toBe(403);
    events.length = 0;
    expect((await owner.json(`/api/access-requests/${r.body.id}/approve`, { method: 'POST' })).status).toBe(200);
    expect(events).toEqual([{ projectId: p.id, userId: v.id, role: 'editor' }]);
    expect((await owner.json(`/api/access-requests/${r.body.id}/deny`, { method: 'POST' })).status).toBe(409);
    expect((await v.json<ProjectDetail>(`/api/projects/${p.id}`)).body.role).toBe('editor');
    expect((await notifs(v)).items[0]).toMatchObject({ type: 'access-decision', payload: { approved: true } });
    expect((await h.waitMail(v.email, 'Pedido de acesso aprovado')).text).toContain(`/p/${p.id}`);
  });

  it('recusar, cancelar, pedir de novo; e as preferências de e-mail desligam só o e-mail', async () => {
    const owner = await h.signup('Wanda');
    const v = await h.signup('Xavi');
    const p = await newProject(owner, 'Agenda');
    await share(owner, p.id, v.email, 'viewer');
    const r1 = await v.json<{ id: string }>(`/api/projects/${p.id}/access-requests`, { method: 'POST', json: {} });
    await owner.json(`/api/access-requests/${r1.body.id}/deny`, { method: 'POST' });
    expect((await v.json<ProjectDetail>(`/api/projects/${p.id}`)).body.role).toBe('viewer');
    // pode pedir de novo depois de recusado, e cancelar
    const r2 = await v.json<{ id: string }>(`/api/projects/${p.id}/access-requests`, { method: 'POST', json: {} });
    expect(r2.status).toBe(201);
    expect((await owner.json(`/api/access-requests/${r2.body.id}/cancel`, { method: 'POST' })).status).toBe(403);
    expect((await v.json(`/api/access-requests/${r2.body.id}/cancel`, { method: 'POST' })).status).toBe(200);

    // dono desliga e-mails de pedidos: recebe só in-app
    const put = await owner.json<{ emailPrefs: { accessRequests: boolean } }>('/api/me/settings', { method: 'PUT', json: { accessRequests: false } });
    expect(put.body.emailPrefs.accessRequests).toBe(false);
    const before = h.mailer.sent.filter((m) => m.to === owner.email).length;
    const r3 = await v.json<{ id: string }>(`/api/projects/${p.id}/access-requests`, { method: 'POST', json: {} });
    expect(r3.status).toBe(201);
    await new Promise((res) => setTimeout(res, 100));
    expect(h.mailer.sent.filter((m) => m.to === owner.email).length).toBe(before);
    expect((await notifs(owner)).items[0].payload.requestId).toBe(r3.body.id);
  });
});

describe('fila de e-mails (pg-boss)', () => {
  it('tenta de novo com backoff quando o provedor falha', async () => {
    let calls = 0;
    const got: MailMessage[] = [];
    const flaky: Mailer = {
      async send(m) {
        calls++;
        if (calls < 3) throw new Error('provedor fora do ar');
        got.push(m);
      },
    };
    const q = new BossMailQueue(h.url, flaky, createLogger('silent'), { retryDelay: 1, pollingIntervalSeconds: 0.5 });
    await q.start();
    try {
      await q.enqueue({ kind: 'accessDecision', to: 'a@x.com', props: { project: 'P', approved: true, url: 'http://x', prefsUrl: 'http://x/settings' } });
      for (let i = 0; i < 200 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(3);
      expect(got[0].subject).toBe('Pedido de acesso aprovado');
    } finally {
      await q.stop();
    }
  }, 40_000);
});
