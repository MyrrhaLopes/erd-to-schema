import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { accessRequests, and, asc, auditLog, canvases, count, desc, eq, inArray, isNull, projectMembers, projects, sql, users } from '@erd/db';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { parse as pgParse } from 'libpg-query';
import { can, CreateCanvasZ, CreateProjectZ, TransferZ, UpdateProjectZ, type CanvasSummary, type ProjectDetail, type ProjectSummary } from '@erd/contracts';
import { emptyProjectDoc, fromProject, invalidEntities } from '@erd/crdt';
import { buildSampleProject } from '@erd/model/sample';
import { parseSql } from '@erd/model/formats/sql/parse';
import { projectAccess, requireCan, requireUser, type AppEnv, type Deps } from '../context';
import { renderThumbnail } from '../thumbnail';

export const newId = (prefix: string) => `${prefix}_${nanoid(12)}`;

const MAX_IMPORT = 5 * 1024 * 1024;

/** Valida um estado inicial vindo do cliente: o servidor não aceita um documento com lixo */
export function decodeInitialState(b64: string): Uint8Array {
  let update: Uint8Array;
  try {
    update = new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    throw new HTTPException(422, { message: 'Estado inicial inválido' });
  }
  if (update.byteLength > MAX_IMPORT) throw new HTTPException(413, { message: 'Projeto grande demais para importar' });
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch {
    throw new HTTPException(422, { message: 'Estado inicial inválido' });
  }
  const bad = invalidEntities(doc);
  doc.destroy();
  if (bad.length) throw new HTTPException(422, { message: `Projeto com ${bad.length} entidade(s) inválida(s): ${bad.slice(0, 3).join(', ')}` });
  return update;
}

export const canvasSummary = (c: typeof canvases.$inferSelect): CanvasSummary => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  position: c.position,
  updatedAt: c.updatedAt.toISOString(),
});

export function projectsRoutes(deps: Deps) {
  const { db, store } = deps;

  return new Hono<AppEnv>()
    .get('/', zValidator('query', z.object({ filter: z.enum(['mine', 'shared', 'all']).default('all') })), async (c) => {
      const user = requireUser(c.get('user'));
      const { filter } = c.req.valid('query');
      const rows = await db
        .select({ p: projects, role: projectMembers.role, ownerName: users.name })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .innerJoin(users, eq(users.id, projects.ownerId))
        .where(
          and(
            eq(projectMembers.userId, user.id),
            isNull(projects.deletedAt),
            filter === 'mine' ? eq(projectMembers.role, 'owner') : filter === 'shared' ? sql`${projectMembers.role} <> 'owner'` : undefined,
          ),
        )
        .orderBy(desc(projects.updatedAt));
      const ids = rows.map((r) => r.p.id);
      const memberCounts = ids.length
        ? await db.select({ id: projectMembers.projectId, n: count() }).from(projectMembers).where(inArray(projectMembers.projectId, ids)).groupBy(projectMembers.projectId)
        : [];
      const pending = ids.length
        ? await db
            .select({ id: accessRequests.projectId, n: count() })
            .from(accessRequests)
            .where(and(inArray(accessRequests.projectId, ids), eq(accessRequests.status, 'pending')))
            .groupBy(accessRequests.projectId)
        : [];
      const out: ProjectSummary[] = rows.map((r) => ({
        id: r.p.id,
        name: r.p.name,
        role: r.role,
        owner: { id: r.p.ownerId, name: r.ownerName },
        updatedAt: r.p.updatedAt.toISOString(),
        thumbnailUrl: `/api/projects/${r.p.id}/thumbnail.svg?v=${r.p.updatedAt.getTime()}`,
        members: memberCounts.find((m) => m.id === r.p.id)?.n ?? 1,
        pendingRequests: can(r.role, 'approveRequests', r.p.settings) ? (pending.find((m) => m.id === r.p.id)?.n ?? 0) : undefined,
      }));
      return c.json(out);
    })

    .post('/', zValidator('json', CreateProjectZ), async (c) => {
      const user = requireUser(c.get('user'));
      const body = c.req.valid('json');
      const [owned] = await db
        .select({ n: count() })
        .from(projects)
        .where(and(eq(projects.ownerId, user.id), isNull(projects.deletedAt)));
      if ((owned?.n ?? 0) >= deps.env.MAX_PROJECTS_PER_USER) throw new HTTPException(422, { message: `Limite de ${deps.env.MAX_PROJECTS_PER_USER} projetos por conta atingido` });
      let initial: Uint8Array;
      if (body.initialState) initial = decodeInitialState(body.initialState);
      else if (body.template === 'sample') {
        const p = await buildSampleProject((s) => parseSql(s, pgParse as never), () => newId('n'));
        initial = fromProject({ ...p, name: body.name });
      } else initial = fromProject(emptyProjectDoc(body.name));

      const projectId = newId('p');
      const canvasId = newId('c');
      await db.transaction(async (tx) => {
        await tx.insert(projects).values({ id: projectId, name: body.name, ownerId: user.id });
        await tx.insert(projectMembers).values({ projectId, userId: user.id, role: 'owner', color: 0, addedBy: user.id });
        await tx.insert(canvases).values({ id: canvasId, projectId, kind: 'erd', name: 'Diagrama ER', position: 0 });
        await tx.insert(auditLog).values({ projectId, actorId: user.id, action: 'project.created', payload: { template: body.initialState ? 'import' : body.template } });
      });
      await store.initialize(canvasId, initial);
      return c.json({ id: projectId, canvasId }, 201);
    })

    .get('/:id', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      const list = await db
        .select()
        .from(canvases)
        .where(and(eq(canvases.projectId, a.project.id), isNull(canvases.deletedAt)))
        .orderBy(asc(canvases.position), asc(canvases.createdAt));
      const [owner] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, a.project.ownerId));
      const [myRequest] = await db
        .select({ id: accessRequests.id, status: accessRequests.status })
        .from(accessRequests)
        .where(and(eq(accessRequests.projectId, a.project.id), eq(accessRequests.requesterId, user.id)))
        .orderBy(desc(accessRequests.createdAt))
        .limit(1);
      const out: ProjectDetail = {
        id: a.project.id,
        name: a.project.name,
        role: a.role,
        color: a.color,
        settings: a.settings,
        owner: owner ?? { id: a.project.ownerId, name: '?' },
        canvases: list.map(canvasSummary),
        updatedAt: a.project.updatedAt.toISOString(),
        myRequest: myRequest ?? null,
      };
      return c.json(out);
    })

    /** Miniatura do primeiro canvas (SVG a partir do último snapshot projetado) */
    .get('/:id/thumbnail.svg', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      const [first] = await db
        .select({ id: canvases.id })
        .from(canvases)
        .where(and(eq(canvases.projectId, a.project.id), isNull(canvases.deletedAt)))
        .orderBy(asc(canvases.position), asc(canvases.createdAt))
        .limit(1);
      const snap = first ? ((await store.snapshot(first.id)) as Parameters<typeof renderThumbnail>[0]) : null;
      return c.body(renderThumbnail(snap), 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' });
    })

    .patch('/:id', zValidator('json', UpdateProjectZ), async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      const body = c.req.valid('json');
      const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) {
        requireCan(a, 'rename');
        patch.name = body.name;
      }
      if (body.settings) {
        requireCan(a, 'changeSettings');
        patch.settings = { ...a.settings, ...body.settings };
      }
      await db.update(projects).set(patch).where(eq(projects.id, a.project.id));
      await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'project.updated', payload: body });
      // desligar o link derruba na hora quem entrou só por ele
      if (body.settings?.linkSharing === 'off' && a.settings.linkSharing === 'view')
        await deps.events.permissionChanged({ projectId: a.project.id, userId: '*', role: null });
      return c.json({ ok: true });
    })

    .delete('/:id', async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'delete');
      await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, a.project.id));
      await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'project.deleted', payload: {} });
      return c.json({ ok: true });
    })

    .post('/:id/transfer', zValidator('json', TransferZ), async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'transfer');
      const { userId } = c.req.valid('json');
      if (userId === user.id) throw new HTTPException(422, { message: 'Você já é o dono' });
      const [target] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, userId)));
      if (!target) throw new HTTPException(422, { message: 'Só é possível transferir para um membro do projeto' });
      await db.transaction(async (tx) => {
        await tx.update(projectMembers).set({ role: 'owner' }).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, userId)));
        await tx.update(projectMembers).set({ role: 'editor' }).where(and(eq(projectMembers.projectId, a.project.id), eq(projectMembers.userId, user.id)));
        await tx.update(projects).set({ ownerId: userId, updatedAt: new Date() }).where(eq(projects.id, a.project.id));
        await tx.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'project.transferred', payload: { to: userId } });
      });
      await deps.events.permissionChanged({ projectId: a.project.id, userId, role: 'owner' });
      await deps.events.permissionChanged({ projectId: a.project.id, userId: user.id, role: 'editor' });
      return c.json({ ok: true });
    })

    .post('/:id/canvases', zValidator('json', CreateCanvasZ), async (c) => {
      const user = requireUser(c.get('user'));
      const a = await projectAccess(db, c.req.param('id'), user.id);
      requireCan(a, 'manageCanvases');
      const body = c.req.valid('json');
      if (body.kind === 'flow') throw new HTTPException(422, { message: 'O canvas de fluxos de usuário ainda não está disponível' });
      const [nc] = await db.select({ n: count() }).from(canvases).where(and(eq(canvases.projectId, a.project.id), isNull(canvases.deletedAt)));
      if ((nc?.n ?? 0) >= deps.env.MAX_CANVASES_PER_PROJECT) throw new HTTPException(422, { message: `Limite de ${deps.env.MAX_CANVASES_PER_PROJECT} canvases por projeto atingido` });
      const [pos] = await db.select({ n: sql<number>`coalesce(max(${canvases.position}), -1) + 1` }).from(canvases).where(eq(canvases.projectId, a.project.id));
      const id = newId('c');
      const [row] = await db.insert(canvases).values({ id, projectId: a.project.id, kind: body.kind, name: body.name, position: Number(pos?.n ?? 0) }).returning();
      await store.initialize(id, fromProject(emptyProjectDoc(a.project.name)));
      return c.json(canvasSummary(row), 201);
    });
}
