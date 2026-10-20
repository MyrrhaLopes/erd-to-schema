import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  accessRequests,
  and,
  auditLog,
  count,
  desc,
  eq,
  gt,
  inArray,
  invitations,
  isNull,
  notifications,
  projectMembers,
  projects,
  sql,
  users,
} from '@erd/db';
import {
  AddMemberZ,
  can,
  ChangeRoleZ,
  CreateAccessRequestZ,
  MarkReadZ,
  pickColor,
  type AccessRequest,
  type Invitation,
  type Member,
  type Notification,
  type Role,
} from '@erd/contracts';
import { projectAccess, requireCan, requireUser, type AppEnv, type Deps } from '../context';
import { approversOf, emailIfAllowed, notify } from '../notify';

const INVITE_TTL_MS = 7 * 86400_000;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

async function membersOf(deps: Deps, projectId: string): Promise<Member[]> {
  const rows = await deps.db
    .select({ userId: users.id, name: users.name, email: users.email, image: users.image, role: projectMembers.role, color: projectMembers.color, createdAt: projectMembers.createdAt })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(projectMembers.createdAt);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Antiabuso (§7.2): compartilhar dispara e-mail para endereços arbitrários */
async function checkInviteRate(deps: Deps, userId: string) {
  const since = new Date(Date.now() - 3600_000);
  const [r] = await deps.db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.actorId, userId), inArray(auditLog.action, ['member.added', 'member.invited']), gt(auditLog.createdAt, since)));
  if ((r?.n ?? 0) >= deps.env.INVITES_PER_HOUR) throw new HTTPException(429, { message: 'Limite de convites por hora atingido. Tente mais tarde.' });
}

/** Adiciona (ou reativa) um membro numa transação, com cor estável ainda não usada no projeto */
async function addMember(deps: Deps, projectId: string, userId: string, role: Role, by: string) {
  const used = await deps.db.select({ c: projectMembers.color }).from(projectMembers).where(eq(projectMembers.projectId, projectId));
  const color = pickColor(used.map((u) => u.c));
  await deps.db
    .insert(projectMembers)
    .values({ projectId, userId, role, color, addedBy: by })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role } });
}

const projectUrl = (deps: Deps, id: string) => `${deps.env.APP_URL}/p/${id}`;
const prefsUrl = (deps: Deps) => `${deps.env.APP_URL}/settings`;

/** /projects/:id/members, /invitations, /access-requests do projeto */
export function projectSharingRoutes(deps: Deps) {
  const { db } = deps;
  return new Hono<AppEnv>()
    .get('/:id/members', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      const members = await membersOf(deps, a.project.id);
      let pending: Invitation[] = [];
      if (can(a.role, 'share', a.settings)) {
        const inv = await db
          .select()
          .from(invitations)
          .where(and(eq(invitations.projectId, a.project.id), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
          .orderBy(desc(invitations.createdAt));
        pending = inv.map((i) => ({ id: i.id, email: i.email, role: i.role as 'editor' | 'viewer', expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }));
      }
      return c.json({ members, invitations: pending });
    })

    /** Compartilhar com um e-mail: vira membro direto (se tem conta) ou convite com link assinado */
    .post('/:id/members', zValidator('json', AddMemberZ), async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'share');
      const { role } = c.req.valid('json');
      const email = c.req.valid('json').email.toLowerCase();
      await checkInviteRate(deps, user.id);
      const [target] = await db.select().from(users).where(eq(users.email, email));
      if (target) {
        const [existing] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, target.id)));
        if (existing) throw new HTTPException(409, { message: 'Essa pessoa já tem acesso ao projeto' });
        await addMember(deps, a.project.id, target.id, role, user.id);
        await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'member.added', payload: { userId: target.id, role } });
        await notify(deps, [target.id], 'member-added', { projectId: a.project.id, projectName: a.project.name, role, by: user.name });
        await emailIfAllowed(deps, target.id, 'membership', {
          kind: 'memberChanged',
          to: target.email,
          props: { project: a.project.name, role, by: user.name, added: true, url: projectUrl(deps, a.project.id), prefsUrl: prefsUrl(deps) },
        });
        await deps.events.permissionChanged({ projectId: a.project.id, userId: target.id, role });
        return c.json({ kind: 'member' as const, userId: target.id }, 201);
      }
      // sem conta: convite por e-mail (o token só existe no link; no banco fica o hash)
      const token = randomBytes(32).toString('base64url');
      const id = `iv_${nanoid(12)}`;
      await db.insert(invitations).values({ id, projectId: a.project.id, email, role, tokenHash: hashToken(token), invitedBy: user.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) });
      await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'member.invited', payload: { email, role } });
      await deps.mail.enqueue({ kind: 'invite', to: email, props: { inviter: user.name, project: a.project.name, role, url: `${deps.env.APP_URL}/invite/${token}` } });
      return c.json({ kind: 'invitation' as const, id }, 201);
    })

    .patch('/:id/members/:userId', zValidator('json', ChangeRoleZ), async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'manageMembers');
      const userId = c.req.param('userId');
      const { role } = c.req.valid('json');
      const [m] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, userId)));
      if (!m) throw new HTTPException(404, { message: 'Membro não encontrado' });
      if (m.role === 'owner') throw new HTTPException(422, { message: 'O papel do dono só muda por transferência' });
      if (m.role === role) return c.json({ ok: true });
      await db.transaction(async (tx) => {
        await tx.update(projectMembers).set({ role }).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, userId)));
        await tx.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'member.role-changed', payload: { userId, from: m.role, to: role } });
      });
      await deps.events.permissionChanged({ projectId: a.project.id, userId, role });
      await notify(deps, [userId], 'role-changed', { projectId: a.project.id, projectName: a.project.name, role, by: user.name });
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (u)
        await emailIfAllowed(deps, userId, 'membership', {
          kind: 'memberChanged',
          to: u.email,
          props: { project: a.project.name, role, by: user.name, added: false, url: projectUrl(deps, a.project.id), prefsUrl: prefsUrl(deps) },
        });
      return c.json({ ok: true });
    })

    /** Remover alguém (ou sair do projeto, se for o próprio usuário) */
    .delete('/:id/members/:userId', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      const userId = c.req.param('userId');
      const self = userId === user.id;
      if (!self) requireCan(a, 'manageMembers');
      const [m] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, userId)));
      if (!m) throw new HTTPException(404, { message: 'Membro não encontrado' });
      if (m.role === 'owner') throw new HTTPException(422, { message: self ? 'Transfira o projeto antes de sair' : 'O dono não pode ser removido' });
      await db.transaction(async (tx) => {
        await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, userId)));
        await tx.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: self ? 'member.left' : 'member.removed', payload: { userId } });
      });
      await deps.events.permissionChanged({ projectId: a.project.id, userId, role: a.settings.linkSharing === 'view' ? 'viewer' : null });
      if (!self) await notify(deps, [userId], 'member-removed', { projectId: a.project.id, projectName: a.project.name, by: user.name });
      return c.json({ ok: true });
    })

    .delete('/:id/invitations/:invId', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'share');
      await db.delete(invitations).where(and(eq(invitations.id, c.req.param('invId')), eq(invitations.projectId, a.project.id)));
      return c.json({ ok: true });
    })

    /** O viewer pede acesso de edição: só um pedido pendente por pessoa */
    .post('/:id/access-requests', zValidator('json', CreateAccessRequestZ), async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'requestAccess');
      const message = c.req.valid('json').message?.trim().slice(0, 500) || null;
      const id = `ar_${nanoid(12)}`;
      try {
        await db.insert(accessRequests).values({ id, projectId: a.project.id, requesterId: user.id, requestedRole: 'editor', message });
      } catch (e) {
        if (String((e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === '23505')
          throw new HTTPException(409, { message: 'Você já tem um pedido pendente neste projeto' });
        throw e;
      }
      const approvers = await approversOf(deps, a.project.id, a.settings);
      await notify(
        deps,
        approvers.map((x) => x.id),
        'access-request',
        { projectId: a.project.id, projectName: a.project.name, requestId: id, requester: user.name },
      );
      for (const ap of approvers)
        await emailIfAllowed(deps, ap.id, 'accessRequests', {
          kind: 'accessRequest',
          to: ap.email,
          props: { requester: user.name, email: user.email, project: a.project.name, message, url: `${deps.env.APP_URL}/p/${a.project.id}/settings?request=${id}`, prefsUrl: prefsUrl(deps) },
        });
      return c.json({ id }, 201);
    })

    .get('/:id/access-requests', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'approveRequests');
      const rows = await db
        .select({ r: accessRequests, name: users.name, email: users.email })
        .from(accessRequests)
        .innerJoin(users, eq(users.id, accessRequests.requesterId))
        .where(and(eq(accessRequests.projectId, a.project.id), eq(accessRequests.status, 'pending')))
        .orderBy(desc(accessRequests.createdAt));
      const out: AccessRequest[] = rows.map(({ r, name, email }) => ({
        id: r.id,
        projectId: r.projectId,
        requester: { id: r.requesterId, name, email },
        message: r.message,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      }));
      return c.json(out);
    });
}

/** /access-requests/:id/approve | deny | cancel */
export function accessRequestRoutes(deps: Deps) {
  const { db } = deps;
  const load = async (id: string) => {
    const [r] = await db.select().from(accessRequests).where(eq(accessRequests.id, id));
    if (!r) throw new HTTPException(404, { message: 'Pedido não encontrado' });
    return r;
  };
  const decide = async (c: { get(k: 'user'): import('../auth').SessionUser | null }, id: string, approve: boolean) => {
    const user = requireUser(c.get('user'));
    const r = await load(id);
    const a = await projectAccess(db, r.projectId, user.id);
    requireCan(a, 'approveRequests');
    if (r.status !== 'pending') throw new HTTPException(409, { message: 'Esse pedido já foi decidido' });
    await db.transaction(async (tx) => {
      await tx.update(accessRequests).set({ status: approve ? 'approved' : 'denied', decidedBy: user.id, decidedAt: new Date() }).where(eq(accessRequests.id, id));
      if (approve) {
        const used = await tx.select({ c: projectMembers.color }).from(projectMembers).where(eq(projectMembers.projectId, r.projectId));
        await tx
          .insert(projectMembers)
          .values({ projectId: r.projectId, userId: r.requesterId, role: 'editor', color: pickColor(used.map((u) => u.c)), addedBy: user.id })
          .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: 'editor' } });
      }
      await tx.insert(auditLog).values({ projectId: r.projectId, actorId: user.id, action: approve ? 'access.approved' : 'access.denied', payload: { requestId: id, userId: r.requesterId } });
    });
    if (approve) await deps.events.permissionChanged({ projectId: r.projectId, userId: r.requesterId, role: 'editor' });
    await notify(deps, [r.requesterId], 'access-decision', { projectId: r.projectId, projectName: a.project.name, approved: approve });
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, r.requesterId));
    if (u)
      await emailIfAllowed(deps, r.requesterId, 'decisions', {
        kind: 'accessDecision',
        to: u.email,
        props: { project: a.project.name, approved: approve, url: projectUrl(deps, r.projectId), prefsUrl: prefsUrl(deps) },
      });
  };
  return new Hono<AppEnv>()
    .post('/:id/approve', async (c) => {
      await decide(c, c.req.param('id'), true);
      return c.json({ ok: true });
    })
    .post('/:id/deny', async (c) => {
      await decide(c, c.req.param('id'), false);
      return c.json({ ok: true });
    })
    .post('/:id/cancel', async (c) => {
      const user = requireUser(c.get('user'));
      const r = await load(c.req.param('id'));
      if (r.requesterId !== user.id) throw new HTTPException(403, { message: 'Só quem pediu pode cancelar' });
      if (r.status !== 'pending') throw new HTTPException(409, { message: 'Esse pedido já foi decidido' });
      await db.update(accessRequests).set({ status: 'cancelled', decidedAt: new Date() }).where(eq(accessRequests.id, r.id));
      return c.json({ ok: true });
    });
}

/** /invitations/:token — ver e aceitar um convite */
export function invitationRoutes(deps: Deps) {
  const { db } = deps;
  const find = async (token: string) => {
    const [row] = await db
      .select({ i: invitations, project: projects.name, inviter: users.name })
      .from(invitations)
      .innerJoin(projects, eq(projects.id, invitations.projectId))
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.tokenHash, hashToken(token)), isNull(projects.deletedAt)));
    if (!row) throw new HTTPException(404, { message: 'Convite não encontrado' });
    if (row.i.acceptedAt) throw new HTTPException(410, { message: 'Esse convite já foi usado' });
    if (row.i.expiresAt < new Date()) throw new HTTPException(410, { message: 'Esse convite expirou' });
    return row;
  };
  return new Hono<AppEnv>()
    .get('/:token', async (c) => {
      const row = await find(c.req.param('token'));
      return c.json({ projectId: row.i.projectId, project: row.project, inviter: row.inviter ?? '', email: row.i.email, role: row.i.role });
    })
    .post('/:token/accept', async (c) => {
      const user = requireUser(c.get('user'));
      const row = await find(c.req.param('token'));
      // o convite é para um e-mail: só a conta desse e-mail pode aceitar
      if (row.i.email.toLowerCase() !== user.email.toLowerCase())
        throw new HTTPException(403, { message: `Este convite é para ${row.i.email}. Entre com essa conta para aceitar.` });
      const [existing] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, row.i.projectId), eq(projectMembers.userId, user.id)));
      await db.transaction(async (tx) => {
        await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, row.i.id));
        await tx.insert(auditLog).values({ projectId: row.i.projectId, actorId: user.id, action: 'invitation.accepted', payload: { invitationId: row.i.id } });
      });
      if (!existing || existing.role === 'viewer') await addMember(deps, row.i.projectId, user.id, existing && row.i.role === 'viewer' ? existing.role : row.i.role, row.i.invitedBy ?? user.id);
      await deps.events.permissionChanged({ projectId: row.i.projectId, userId: user.id, role: row.i.role });
      return c.json({ projectId: row.i.projectId });
    });
}

/** /notifications */
export function notificationRoutes(deps: Deps) {
  const { db } = deps;
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const user = requireUser(c.get('user'));
      const rows = await db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.createdAt)).limit(50);
      const [unread] = await db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
      const items: Notification[] = rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
      return c.json({ items, unread: unread?.n ?? 0 });
    })
    .post('/read', zValidator('json', MarkReadZ), async (c) => {
      const user = requireUser(c.get('user'));
      const { ids } = c.req.valid('json');
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt), ids?.length ? inArray(notifications.id, ids) : sql`true`));
      return c.json({ ok: true });
    });
}
