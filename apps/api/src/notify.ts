import { nanoid } from 'nanoid';
import { and, eq, inArray, notifications, projectMembers, users } from '@erd/db';
import type { EmailPrefs, ProjectSettings } from '@erd/contracts';
import type { Deps } from './context';
import type { EmailJob } from './mailQueue';
import { emailPrefs } from './routes/me';

export type NotificationType = 'access-request' | 'access-decision' | 'member-added' | 'role-changed' | 'member-removed';

/** Notificações in-app (sininho + badge) */
export async function notify(deps: Pick<Deps, 'db'>, userIds: string[], type: NotificationType, payload: Record<string, unknown>) {
  if (!userIds.length) return;
  await deps.db.insert(notifications).values(userIds.map((userId) => ({ id: `nt_${nanoid(12)}`, userId, type, payload })));
}

/** Quem pode aprovar pedidos e gerenciar membros: o dono e, se o projeto permitir, os editores */
export async function approversOf(deps: Pick<Deps, 'db'>, projectId: string, settings: ProjectSettings) {
  const roles: ('owner' | 'editor')[] = settings.editorsCanShare ? ['owner', 'editor'] : ['owner'];
  return deps.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.role, roles)));
}

/** E-mails desligáveis respeitam as preferências (o in-app continua) */
export async function emailIfAllowed(deps: Pick<Deps, 'db' | 'mail'>, userId: string, pref: keyof EmailPrefs, job: EmailJob) {
  const prefs = await emailPrefs(deps, userId);
  if (!prefs[pref]) return false;
  await deps.mail.enqueue(job);
  return true;
}
