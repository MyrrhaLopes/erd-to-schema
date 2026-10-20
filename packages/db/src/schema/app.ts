import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { EmailPrefs, ProjectSettings } from '@erd/contracts';
import { users } from './auth';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  fromDriver: (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
});

const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts('created_at').notNull().defaultNow();

export const roleEnum = pgEnum('member_role', ['owner', 'editor', 'viewer']);
export const canvasKindEnum = pgEnum('canvas_kind', ['erd', 'flow']);
export const requestStatusEnum = pgEnum('access_request_status', ['pending', 'approved', 'denied', 'cancelled']);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    settings: jsonb('settings').$type<ProjectSettings>().notNull().default({ editorsCanShare: false, linkSharing: 'off' }),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('projects_owner_idx').on(t.ownerId)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    /** Índice na paleta, estável por projeto */
    color: integer('color').notNull().default(0),
    addedBy: text('added_by').references(() => users.id),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user_idx').on(t.userId)],
);

/** Convite para e-mail que ainda não tem conta (ou que ainda não aceitou) */
export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: text('invited_by').references(() => users.id),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    createdAt: created(),
  },
  (t) => [index('invitations_project_idx').on(t.projectId), index('invitations_email_idx').on(t.email)],
);

export const accessRequests = pgTable(
  'access_requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requesterId: text('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedRole: roleEnum('requested_role').notNull().default('editor'),
    message: text('message'),
    status: requestStatusEnum('status').notNull().default('pending'),
    decidedBy: text('decided_by').references(() => users.id),
    decidedAt: ts('decided_at'),
    createdAt: created(),
  },
  // só um pedido pendente por pessoa por projeto
  (t) => [uniqueIndex('access_requests_one_pending').on(t.projectId, t.requesterId).where(sql`status = 'pending'`)],
);

export const canvases = pgTable(
  'canvases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: canvasKindEnum('kind').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('canvases_project_idx').on(t.projectId)],
);

/** Log append-only de updates Yjs; compactado periodicamente em `canvas_state` */
export const canvasUpdates = pgTable(
  'canvas_updates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    createdAt: created(),
  },
  (t) => [index('canvas_updates_canvas_idx').on(t.canvasId, t.id)],
);

export const canvasState = pgTable('canvas_state', {
  canvasId: text('canvas_id')
    .primaryKey()
    .references(() => canvases.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  stateVector: bytea('state_vector').notNull(),
  /** `Project` projetado, para listagem, export e busca */
  jsonSnapshot: jsonb('json_snapshot'),
  thumbnailUrl: text('thumbnail_url'),
  /** Último update do log já incluído em `state` */
  lastUpdateId: bigint('last_update_id', { mode: 'number' }).notNull().default(0),
  compactedAt: ts('compacted_at').notNull().defaultNow(),
});

export const canvasVersions = pgTable(
  'canvas_versions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    state: bytea('state').notNull(),
    createdBy: text('created_by').references(() => users.id),
    /** Versão de uma publicação no Drive: não conta no limite, não é podada nem apagada */
    protected: boolean('protected').notNull().default(false),
    createdAt: created(),
  },
  (t) => [index('canvas_versions_canvas_idx').on(t.canvasId, t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    readAt: ts('read_at'),
    createdAt: created(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id),
    action: text('action').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index('audit_log_project_idx').on(t.projectId, t.createdAt)],
);

/** Preferências de e-mail (Configurações > Notificações) */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  emailPrefs: jsonb('email_prefs').$type<EmailPrefs>().notNull().default({ accessRequests: true, decisions: true, membership: true, drive: true }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Documento Word no Google Drive (docs/drive-docx-plan.md §7)          */
/* Só metadados: nenhuma tabela guarda bytes do .docx.                  */
/* ------------------------------------------------------------------ */

/** Um vínculo por canvas: onde o documento está publicado */
export const driveBindings = pgTable('drive_bindings', {
  canvasId: text('canvas_id')
    .primaryKey()
    .references(() => canvases.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  /** Dono do arquivo no Drive (cujo token é usado) */
  connectedUserId: text('connected_user_id').references(() => users.id, { onDelete: 'set null' }),
  folderId: text('folder_id').notNull(),
  folderName: text('folder_name').notNull(),
  folderPath: text('folder_path'),
  fileId: text('file_id'),
  fileName: text('file_name'),
  webViewLink: text('web_view_link'),
  lastRevisionId: text('last_revision_id'),
  lastMd5: text('last_md5'),
  lastContentHash: text('last_content_hash'),
  lastVersion: integer('last_version').notNull().default(0),
  /** none | locked | pending */
  lock: text('lock').notNull().default('none'),
  /** active | needs_reconnect | needs_folder | transfer_pending | paused */
  status: text('status').notNull().default('active'),
  /** Última anomalia avisada (para não repetir o aviso a cada auditoria) */
  anomaly: text('anomaly'),
  /** Fase 4: publicar ao salvar uma versão nomeada (sem a tela de revisão) */
  autoPublish: boolean('auto_publish').notNull().default(false),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Append-only: cada publicação, troca de pasta ou evento observado no Drive */
export const drivePublications = pgTable(
  'drive_publications',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    /** published | unchanged | failed | folder_changed | recreated | external_edit_detected | moved_externally | relocked | disconnected | owner_transferred */
    action: text('action').notNull(),
    /** "versão N" da capa (só em published) */
    version: integer('version'),
    revertedFrom: integer('reverted_from'),
    canvasVersionId: text('canvas_version_id').references(() => canvasVersions.id, { onDelete: 'set null' }),
    /** Quem pediu no app (null = job automático) */
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    fileId: text('file_id'),
    driveRevisionId: text('drive_revision_id'),
    md5: text('md5'),
    sizeBytes: integer('size_bytes'),
    contentHash: text('content_hash'),
    folderId: text('folder_id'),
    folderName: text('folder_name'),
    previousFolderId: text('previous_folder_id'),
    previousFolderName: text('previous_folder_name'),
    previousFileId: text('previous_file_id'),
    oldFileDeletedAt: ts('old_file_deleted_at'),
    /** `lastModifyingUser` do Drive, quando alguém editou por fora */
    externalActor: jsonb('external_actor').$type<{ name?: string; email?: string }>(),
    error: text('error'),
    createdAt: created(),
  },
  (t) => [index('drive_publications_canvas_idx').on(t.canvasId, t.createdAt)],
);

/** Arquivos a excluir definitivamente, com retentativa e o token de quem usar */
export const drivePendingDeletions = pgTable('drive_pending_deletions', {
  fileId: text('file_id').primaryKey(),
  canvasId: text('canvas_id').notNull(),
  tokenUserId: text('token_user_id').references(() => users.id, { onDelete: 'set null' }),
  folderId: text('folder_id'),
  folderName: text('folder_name'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
  /** Passou do limite de 24 h: a interface pede a exclusão manual */
  gaveUpAt: ts('gave_up_at'),
  createdAt: created(),
});
