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
  /** Avisos do documento no Drive (edição externa, falhas, troca de posse) */
  drive: z.boolean().default(true),
});
export type EmailPrefs = z.infer<typeof EmailPrefsZ>;

export const VersionZ = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Versão de publicação no Drive: não conta no limite, não é podada nem apagada */
  protected: z.boolean().optional(),
});
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
  z.object({ type: z.literal('restored'), versionId: z.string(), label: z.string().optional(), by: z.string().optional() }),
  z.object({
    type: z.literal('drive'),
    event: z.enum(['published', 'failed', 'folder_changed', 'unchanged']),
    by: z.string().optional(),
    version: z.number().optional(),
    link: z.string().optional(),
    error: z.string().optional(),
  }),
]);
export type Stateless = z.infer<typeof StatelessZ>;

/** Evento publicado pela API quando um papel muda (Postgres LISTEN/NOTIFY ou Redis); `userId: '*'` reavalia todos do projeto */
export const PermissionChangedZ = z.object({ projectId: z.string(), userId: z.string(), role: RoleZ.nullable() });
export type PermissionChanged = z.infer<typeof PermissionChangedZ>;

/* ------------------------------------------------------------------ */
/* Documento Word no Google Drive (docs/drive-docx-plan.md)             */
/* ------------------------------------------------------------------ */

export const DRIVE_BINDING_STATUS = ['active', 'needs_reconnect', 'needs_folder', 'transfer_pending', 'paused'] as const;
export type DriveBindingStatus = (typeof DRIVE_BINDING_STATUS)[number];

export const DRIVE_ACTIONS = [
  'published',
  'unchanged',
  'failed',
  'folder_changed',
  'recreated',
  'external_edit_detected',
  'moved_externally',
  'relocked',
  'disconnected',
  'owner_transferred',
] as const;
export type DriveAction = (typeof DRIVE_ACTIONS)[number];

export const DriveConfigZ = z.object({
  enabled: z.boolean(),
  provider: z.enum(['google', 'fake']),
  pickerApiKey: z.string().nullable(),
  appId: z.string().nullable(),
  clientId: z.string().nullable(),
  /** Nomes das variáveis do `server` que faltam para o Drive ligar (diagnóstico na interface) */
  missing: z.array(z.string()),
});
export type DriveConfig = z.infer<typeof DriveConfigZ>;

export const DriveBindingZ = z.object({
  canvasId: z.string(),
  canvasName: z.string(),
  folderId: z.string(),
  folderName: z.string(),
  folderPath: z.string().nullable(),
  fileId: z.string().nullable(),
  fileName: z.string().nullable(),
  webViewLink: z.string().nullable(),
  lastVersion: z.number(),
  lastContentHash: z.string().nullable(),
  lastPublishedAt: z.string().nullable(),
  lastPublishedBy: z.string().nullable(),
  lock: z.enum(['none', 'locked', 'pending']),
  status: z.enum(DRIVE_BINDING_STATUS),
  /** Problema observado no Drive (edição externa, arquivo sumido...), para a faixa no diálogo */
  anomaly: z.string().nullable(),
  autoPublish: z.boolean(),
  connectedUser: z.object({ id: z.string(), name: z.string() }).nullable(),
  pendingDeletions: z.array(z.object({ fileId: z.string(), folderName: z.string().nullable(), attempts: z.number(), lastError: z.string().nullable(), manual: z.boolean(), link: z.string() })),
});
export type DriveBinding = z.infer<typeof DriveBindingZ>;

export const DriveProjectZ = z.object({
  enabled: z.boolean(),
  provider: z.enum(['google', 'fake']),
  isOwner: z.boolean(),
  owner: z.object({ id: z.string(), name: z.string() }),
  /** Conta Google do dono com o escopo do Drive */
  account: z.object({ connected: z.boolean(), email: z.string().nullable(), name: z.string().nullable() }),
  bindings: z.array(DriveBindingZ),
});
export type DriveProject = z.infer<typeof DriveProjectZ>;

export const DrivePublicationZ = z.object({
  id: z.string(),
  action: z.enum(DRIVE_ACTIONS),
  version: z.number().nullable(),
  revertedFrom: z.number().nullable(),
  canvasVersionId: z.string().nullable(),
  requestedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  folderName: z.string().nullable(),
  previousFolderName: z.string().nullable(),
  oldFileDeletedAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  externalActor: z.object({ name: z.string().optional(), email: z.string().optional() }).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type DrivePublication = z.infer<typeof DrivePublicationZ>;

export const PublishZ = z.object({ reviewedHash: z.string().min(8).max(128), revertedFrom: z.number().int().positive().optional() });
export const DriveFolderZ = z.object({ folderId: z.string().min(1).max(200) });
export const DriveSettingsZ = z.object({ autoPublish: z.boolean() });
export const DriveJobStateZ = z.object({ state: z.enum(['queued', 'active', 'completed', 'failed', 'unknown']) });
