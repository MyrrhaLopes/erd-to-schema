/**
 * Operações da Drive API v3 que o documento usa (drive-docx-plan §2, §3, §5, §8). Duas
 * implementações: `GoogleDrive` (REST com `fetch`) e `FakeDrive` (memória, para testes e E2E).
 * Todo método recebe o token de acesso de quem é dono do arquivo (o dono do projeto).
 */
export interface DriveUser {
  name?: string;
  email?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  md5Checksum?: string;
  headRevisionId?: string;
  size?: number;
  trashed: boolean;
  parents: string[];
  webViewLink?: string;
  /** Bloqueio de conteúdo (readOnly) ativo, e se só o dono pode tirar */
  locked: boolean;
  ownerRestricted: boolean;
  canModifyOwnerContentRestriction: boolean;
  lastModifyingUser?: DriveUser;
  appProperties?: Record<string, string>;
}

export interface DriveFolder {
  id: string;
  name: string;
  isFolder: boolean;
  canAddChildren: boolean;
  /** Caminho para mostrar na interface ("Meu Drive / Projetos / CESS") */
  path: string | null;
}

export interface DriveRevision {
  id: string;
  modifiedTime?: string;
  lastModifyingUser?: DriveUser;
}

export interface NewFile {
  name: string;
  folderId: string;
  bytes: Uint8Array;
  appProperties: Record<string, string>;
  description: string;
  lockReason: string;
}

export interface DriveProvider {
  readonly kind: 'google' | 'fake';
  about(token: string): Promise<DriveUser>;
  getFolder(token: string, folderId: string): Promise<DriveFolder>;
  /** `null` quando o arquivo não existe mais (404) */
  getFile(token: string, fileId: string): Promise<DriveFile | null>;
  /** Cria já bloqueado (`contentRestrictions` readOnly + ownerRestricted) */
  createFile(token: string, f: NewFile): Promise<DriveFile>;
  updateContent(token: string, fileId: string, bytes: Uint8Array, name?: string): Promise<DriveFile>;
  setLock(token: string, fileId: string, locked: boolean, reason?: string): Promise<DriveFile>;
  move(token: string, fileId: string, toFolderId: string, fromFolderIds: string[]): Promise<DriveFile>;
  listRevisions(token: string, fileId: string): Promise<DriveRevision[]>;
  deleteRevision(token: string, fileId: string, revisionId: string): Promise<void>;
  /** Exclusão definitiva (sem lixeira); 404 conta como sucesso */
  deleteFile(token: string, fileId: string): Promise<void>;
  /** Arquivos deste app para um canvas numa pasta, incluindo os que estão na lixeira */
  findAppFiles(token: string, folderId: string, canvasId: string): Promise<DriveFile[]>;
}

export type DriveErrorCode = 'not_found' | 'forbidden' | 'rate_limited' | 'server' | 'invalid_grant' | 'restricted' | 'bad_request';

export class DriveError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
  /** 429 e 5xx: a fila tenta de novo com backoff */
  get retryable() {
    return this.code === 'rate_limited' || this.code === 'server';
  }
}

export const DRIVE_FILE_DESCRIPTION = 'Gerado pelo ERD Builder. Não edite nem reverta pelo Drive: use o histórico do app.';
export const DRIVE_LOCK_REASON = 'Documento gerado pelo ERD Builder. Edições e reversões só pelo app.';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
