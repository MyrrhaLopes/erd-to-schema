import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, auditLog, canvases, canvasVersions, count, desc, eq, isNull, users } from '@erd/db';
import { CreateVersionZ, type Version } from '@erd/contracts';
import * as Y from 'yjs';
import { SignJWT } from 'jose';
import { UpdateCanvasZ } from '@erd/contracts';
import { codeText, invalidEntities, projectDoc } from '@erd/crdt';
import type { Format, Project } from '@erd/model/types';
import { FORMATS } from '@erd/model/types';
import { defaultView } from '@erd/model/project';
import { slugify } from '@erd/model/naming';
import { buildProjectZip } from '@erd/model/projectFile';
import { GENERATORS } from '@erd/sync';
import { canvasAccess, requireCan, requireUser, type AppEnv, type Deps } from '../context';
import { canvasSummary } from './projects';

/** Limite de tamanho de um update (§6.1): acima disso, recusa */
export const MAX_UPDATE = 1024 * 1024;

async function readBinary(req: Request, max: number): Promise<Uint8Array> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.byteLength) throw new HTTPException(400, { message: 'Corpo vazio' });
  if (buf.byteLength > max) throw new HTTPException(413, { message: 'Update grande demais' });
  return buf;
}

/** Aplica o update numa cópia do documento e recusa se ele introduz entidades inválidas */
function checkUpdate(current: Uint8Array | null, update: Uint8Array) {
  const doc = new Y.Doc();
  try {
    if (current) Y.applyUpdate(doc, current);
    const before = new Set(invalidEntities(doc));
    Y.applyUpdate(doc, update);
    const after = invalidEntities(doc).filter((x) => !before.has(x));
    if (after.length) throw new HTTPException(422, { message: `Update com entidade(s) inválida(s): ${after.slice(0, 3).join(', ')}` });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new HTTPException(422, { message: 'Update Yjs inválido' });
  } finally {
    doc.destroy();
  }
}

export function canvasesRoutes(deps: Deps) {
  const { db } = deps;
  return (
    new Hono<AppEnv>()
      .patch('/:id', zValidator('json', UpdateCanvasZ), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'manageCanvases');
        const [row] = await db
          .update(canvases)
          .set({ ...c.req.valid('json'), updatedAt: new Date() })
          .where(eq(canvases.id, a.canvas.id))
          .returning();
        return c.json(canvasSummary(row));
      })

      .delete('/:id', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'manageCanvases');
        const [n] = await db
          .select({ n: count() })
          .from(canvases)
          .where(and(eq(canvases.projectId, a.project.id), isNull(canvases.deletedAt)));
        if ((n?.n ?? 0) <= 1) throw new HTTPException(422, { message: 'O projeto precisa de pelo menos um canvas' });
        await db.update(canvases).set({ deletedAt: new Date() }).where(eq(canvases.id, a.canvas.id));
        return c.json({ ok: true });
      })

      /** Token curto (5 min) para o WebSocket (§3): o Hocuspocus confere a assinatura e o canvas */
      .post('/:id/collab-token', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        const expiresAt = Date.now() + 5 * 60_000;
        const token = await new SignJWT({ canvasId: a.canvas.id, projectId: a.project.id, role: a.role, color: a.color, name: user.name })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject(user.id)
          .setIssuedAt()
          .setExpirationTime(Math.floor(expiresAt / 1000))
          .sign(new TextEncoder().encode(deps.env.COLLAB_JWT_SECRET));
        return c.json({ token, role: a.role, color: a.color, name: user.name, userId: user.id, expiresAt });
      })

      /** Estado completo (update Yjs) — carga inicial sem WebSocket e base dos exports */
      .get('/:id/state', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        const state = await deps.writer.read(a.canvas.id);
        return c.body((state ?? new Uint8Array()) as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      })

      /** Update incremental (persistência sem tempo real; o import também passa por aqui) */
      .post('/:id/updates', bodyLimit({ maxSize: MAX_UPDATE * 5 }), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'edit');
        const update = await readBinary(c.req.raw, MAX_UPDATE * 5);
        checkUpdate(await deps.writer.read(a.canvas.id), update);
        await deps.writer.apply(a.canvas.id, update);
        return c.json({ ok: true });
      })

      /** Versões nomeadas e automáticas (§6.3) */
      .get('/:id/versions', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        const rows = await db
          .select({ id: canvasVersions.id, label: canvasVersions.label, createdAt: canvasVersions.createdAt, byId: users.id, byName: users.name })
          .from(canvasVersions)
          .leftJoin(users, eq(users.id, canvasVersions.createdBy))
          .where(eq(canvasVersions.canvasId, a.canvas.id))
          .orderBy(desc(canvasVersions.createdAt))
          .limit(200);
        const out: Version[] = rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt.toISOString(), createdBy: r.byId ? { id: r.byId, name: r.byName ?? '' } : null }));
        return c.json(out);
      })

      .post('/:id/versions', zValidator('json', CreateVersionZ), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'edit');
        const [n] = await db.select({ n: count() }).from(canvasVersions).where(eq(canvasVersions.canvasId, a.canvas.id));
        if ((n?.n ?? 0) >= deps.env.MAX_VERSIONS_PER_CANVAS) throw new HTTPException(422, { message: 'Limite de versões deste canvas atingido. Apague versões antigas.' });
        const state = await deps.writer.read(a.canvas.id);
        if (!state) throw new HTTPException(409, { message: 'O canvas ainda está vazio' });
        const { label } = c.req.valid('json');
        const id = await deps.store.createVersion(a.canvas.id, label, state, user.id);
        await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'version.created', payload: { canvasId: a.canvas.id, versionId: id, label } });
        return c.json({ id }, 201);
      })

      /** Estado de uma versão: o cliente calcula o diff contra o documento atual e aplica como uma edição normal (desfazível) */
      .get('/:id/versions/:vid/state', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        const [v] = await db.select({ state: canvasVersions.state }).from(canvasVersions).where(and(eq(canvasVersions.id, c.req.param('vid')), eq(canvasVersions.canvasId, a.canvas.id)));
        if (!v) throw new HTTPException(404, { message: 'Versão não encontrada' });
        return c.body(v.state as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=86400, immutable' });
      })

      /** Registro da restauração (feita pelo cliente) e aviso a quem está no canvas */
      .post('/:id/versions/:vid/restored', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'edit');
        const [v] = await db.select({ id: canvasVersions.id, label: canvasVersions.label }).from(canvasVersions).where(and(eq(canvasVersions.id, c.req.param('vid')), eq(canvasVersions.canvasId, a.canvas.id)));
        if (!v) throw new HTTPException(404, { message: 'Versão não encontrada' });
        await db.insert(auditLog).values({ projectId: a.project.id, actorId: user.id, action: 'version.restored', payload: { canvasId: a.canvas.id, versionId: v.id } });
        await deps.events.broadcast(a.canvas.id, { type: 'restored', versionId: v.id, label: v.label, by: user.name });
        return c.json({ ok: true });
      })

      .delete('/:id/versions/:vid', async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'manageCanvases');
        await db.delete(canvasVersions).where(and(eq(canvasVersions.id, c.req.param('vid')), eq(canvasVersions.canvasId, a.canvas.id)));
        return c.json({ ok: true });
      })

      .get('/:id/export', zValidator('query', z.object({ format: z.enum(['zip', 'json', 'sql', 'prisma', 'drizzle']).default('zip') })), async (c) => {
        const user = requireUser(c.get('user'));
        const a = await canvasAccess(db, c.req.param('id'), user.id);
        requireCan(a, 'export');
        const { format } = c.req.valid('query');
        const update = await deps.writer.read(a.canvas.id);
        const doc = new Y.Doc();
        if (update) Y.applyUpdate(doc, update);
        const pd = projectDoc(doc);
        const project: Project = { version: 1, ...pd, name: a.project.name, view: defaultView() };
        // os textos como as pessoas escreveram (formatação e comentários); vazio → canônico
        const texts = Object.fromEntries(FORMATS.map((f) => [f, codeText(doc, f).toString() || GENERATORS[f](project)])) as Record<Format, string>;
        doc.destroy();
        const base = slugify(a.project.name);
        if (format === 'zip')
          return c.body(buildProjectZip(project, texts) as Uint8Array<ArrayBuffer>, 200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${base}.erd.zip"`,
          });
        if (format === 'json') return c.json(project);
        const ext = { sql: 'sql', prisma: 'prisma', drizzle: 'schema.ts' }[format];
        return c.body(texts[format], 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.${ext}"` });
      })
  );
}
