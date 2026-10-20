import type pg from 'pg';
import { and, canvases, type Db, eq, isNull, projectMembers, projects } from '@erd/db';
import { HTTPException } from 'hono/http-exception';
import { can, defaultSettings, type Action, type ProjectSettings, type Role } from '@erd/contracts';
import type { CanvasStore, Collab } from '@erd/collab';
import type { Auth, SessionUser } from './auth';
import type { Env } from './env';
import type { Logger } from './log';
import type { Mailer } from './mailer';

/** Eventos para fora da requisição (mudança de papel → servidor de colaboração; e-mails → fila) */
export interface Events {
  permissionChanged(e: { projectId: string; userId: string; role: Role | null }): Promise<void>;
}

/** Escrita num canvas vinda da API (import, restauração): no documento vivo, se houver, ou no log */
export interface CanvasWriter {
  apply(canvasId: string, update: Uint8Array): Promise<void>;
  /** Documento atual (vivo ou do banco) como update Yjs */
  read(canvasId: string): Promise<Uint8Array | null>;
}

export interface Deps {
  db: Db;
  pool: pg.Pool;
  env: Env;
  auth: Auth;
  mailer: Mailer;
  log: Logger;
  store: CanvasStore;
  writer: CanvasWriter;
  events: Events;
  /** Servidor de colaboração no mesmo processo (ausente nos testes que não precisam dele) */
  collab?: Collab;
}

export type AppEnv = { Variables: { user: SessionUser | null } };

export interface Access {
  project: typeof projects.$inferSelect;
  role: Role;
  color: number;
  /** `false` quando a pessoa entrou pelo link de visualização (sem linha em project_members) */
  member: boolean;
  settings: ProjectSettings;
}

export function requireUser(user: SessionUser | null): SessionUser {
  if (!user) throw new HTTPException(401, { message: 'Faça login para continuar' });
  return user;
}

/** Papel do usuário no projeto (ou viewer implícito pelo link); 404 para quem não tem acesso */
export async function projectAccess(db: Db, projectId: string, userId: string): Promise<Access> {
  const [row] = await db
    .select({ project: projects, role: projectMembers.role, color: projectMembers.color })
    .from(projects)
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!row) throw new HTTPException(404, { message: 'Projeto não encontrado' });
  const settings = { ...defaultSettings(), ...(row.project.settings ?? {}) };
  if (row.role) return { project: row.project, role: row.role, color: row.color ?? 0, member: true, settings };
  if (settings.linkSharing === 'view') return { project: row.project, role: 'viewer', color: hashColor(userId), member: false, settings };
  // não revela que o projeto existe
  throw new HTTPException(404, { message: 'Projeto não encontrado' });
}

/** Papel atual (ou viewer pelo link), ou `null` sem acesso — usado também pelo collab ao autenticar */
export async function roleOf(db: Db, projectId: string, userId: string): Promise<Role | null> {
  try {
    return (await projectAccess(db, projectId, userId)).role;
  } catch {
    return null;
  }
}

export async function canvasAccess(db: Db, canvasId: string, userId: string) {
  const [c] = await db.select().from(canvases).where(and(eq(canvases.id, canvasId), isNull(canvases.deletedAt)));
  if (!c) throw new HTTPException(404, { message: 'Canvas não encontrado' });
  const access = await projectAccess(db, c.projectId, userId);
  return { canvas: c, ...access };
}

export function requireCan(a: Pick<Access, 'role' | 'settings'>, action: Action) {
  if (!can(a.role, action, a.settings)) throw new HTTPException(403, { message: 'Você não tem permissão para isso neste projeto' });
}

/** Cor por sessão de quem entrou pelo link (não é membro, então não tem cor guardada) */
export function hashColor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 12;
}
