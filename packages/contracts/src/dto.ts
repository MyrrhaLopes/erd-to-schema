import { z } from 'zod';
import { AssignableRoleZ, ProjectSettingsZ, RoleZ } from './permissions';

export const CanvasKindZ = z.enum(['erd', 'flow']);
export type CanvasKind = z.infer<typeof CanvasKindZ>;

export const UserZ = z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable().optional() });
export type User = z.infer<typeof UserZ>;

export const CanvasSummaryZ = z.object({ id: z.string(), kind: CanvasKindZ, name: z.string(), position: z.number(), updatedAt: z.string() });
export type CanvasSummary = z.infer<typeof CanvasSummaryZ>;

export const ProjectSummaryZ = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleZ,
  owner: z.object({ id: z.string(), name: z.string() }),
  updatedAt: z.string(),
  thumbnailUrl: z.string().nullable().optional(),
  members: z.number(),
  pendingRequests: z.number().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummaryZ>;

export const ProjectDetailZ = z.object({
  id: z.string(),
  name: z.string(),
  role: RoleZ,
  color: z.number(),
  settings: ProjectSettingsZ,
  owner: z.object({ id: z.string(), name: z.string() }),
  canvases: z.array(CanvasSummaryZ),
  updatedAt: z.string(),
  /** Pedido de edição pendente do próprio usuário (viewer) */
  myRequest: z.object({ id: z.string(), status: z.string() }).nullable().optional(),
});
export type ProjectDetail = z.infer<typeof ProjectDetailZ>;

export const CreateProjectZ = z.object({
  name: z.string().trim().min(1).max(120),
  template: z.enum(['empty', 'sample']).default('empty'),
  /** Estado inicial do canvas ERD (update Yjs em base64), montado pelo cliente a partir de um .zip ou do modo local */
  initialState: z.string().max(8_000_000).optional(),
});
export type CreateProject = z.infer<typeof CreateProjectZ>;

export const UpdateProjectZ = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  settings: ProjectSettingsZ.partial().optional(),
});

export const CreateCanvasZ = z.object({ kind: CanvasKindZ, name: z.string().trim().min(1).max(120) });
export const UpdateCanvasZ = z.object({ name: z.string().trim().min(1).max(120).optional(), position: z.number().int().optional() });

export const TransferZ = z.object({ userId: z.string() });

export const MemberZ = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable().optional(),
  role: RoleZ,
  color: z.number(),
  createdAt: z.string(),
});
export type Member = z.infer<typeof MemberZ>;

export const InvitationZ = z.object({ id: z.string(), email: z.string(), role: AssignableRoleZ, expiresAt: z.string(), createdAt: z.string() });
export type Invitation = z.infer<typeof InvitationZ>;

export const AddMemberZ = z.object({ email: z.email().max(320), role: AssignableRoleZ });
export const ChangeRoleZ = z.object({ role: AssignableRoleZ });

export const AccessRequestZ = z.object({
  id: z.string(),
  projectId: z.string(),
  requester: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  message: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']),
  createdAt: z.string(),
});
export type AccessRequest = z.infer<typeof AccessRequestZ>;
export const CreateAccessRequestZ = z.object({ message: z.string().max(500).optional() });

export const NotificationZ = z.object({ id: z.string(), type: z.string(), payload: z.record(z.string(), z.unknown()), readAt: z.string().nullable(), createdAt: z.string() });
export type Notification = z.infer<typeof NotificationZ>;
export const MarkReadZ = z.object({ ids: z.array(z.string()).optional() });

export const EmailPrefsZ = z.object({
  accessRequests: z.boolean().default(true),
  decisions: z.boolean().default(true),
  membership: z.boolean().default(true),
});
export type EmailPrefs = z.infer<typeof EmailPrefsZ>;

export const VersionZ = z.object({ id: z.string(), label: z.string(), createdAt: z.string(), createdBy: z.object({ id: z.string(), name: z.string() }).nullable() });
export type Version = z.infer<typeof VersionZ>;
export const CreateVersionZ = z.object({ label: z.string().trim().min(1).max(120) });

/** Claims do token curto do WebSocket (§3) */
export const CollabClaimsZ = z.object({
  sub: z.string(),
  canvasId: z.string(),
  projectId: z.string(),
  role: RoleZ,
  color: z.number(),
  name: z.string(),
});
export type CollabClaims = z.infer<typeof CollabClaimsZ>;

/** Mensagens fora do documento entre servidor e cliente (stateless messages do Hocuspocus) */
export const StatelessZ = z.discriminatedUnion('type', [
  z.object({ type: z.literal('flush'), format: z.enum(['sql', 'prisma', 'drizzle']) }),
  z.object({ type: z.literal('resolve'), format: z.enum(['sql', 'prisma', 'drizzle']), id: z.string(), choice: z.enum(['text', 'diagram']) }),
  z.object({ type: z.literal('clear-divergent'), format: z.enum(['sql', 'prisma', 'drizzle']) }),
  z.object({ type: z.literal('permission-changed'), role: RoleZ.nullable() }),
  z.object({ type: z.literal('restored'), versionId: z.string() }),
]);
export type Stateless = z.infer<typeof StatelessZ>;

/** Evento publicado pela API quando um papel muda (Postgres LISTEN/NOTIFY ou Redis); `userId: '*'` reavalia todos do projeto */
export const PermissionChangedZ = z.object({ projectId: z.string(), userId: z.string(), role: RoleZ.nullable() });
export type PermissionChanged = z.infer<typeof PermissionChangedZ>;
