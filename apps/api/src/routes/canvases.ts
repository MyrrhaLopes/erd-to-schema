import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, canvases, count, eq, isNull } from '@erd/db';
import * as Y from 'yjs';
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
