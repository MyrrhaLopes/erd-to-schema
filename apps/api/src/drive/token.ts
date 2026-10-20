import { accounts, and, eq, type Db } from '@erd/db';
import type { Auth } from '../auth';
import { DriveError } from './provider';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const hasDriveScope = (scope: string | null) => !!scope && scope.split(/[\s,]+/).includes(DRIVE_SCOPE);

/**
 * Token de acesso do Drive de uma pessoa (§2.1): a conta Google vinculada com o escopo
 * `drive.file`. O Better Auth renova sozinho com o refresh token; se falhar (revogado,
 * conta desvinculada), vira `invalid_grant` e o vínculo vai para `needs_reconnect`.
 */
export class DriveTokens {
  constructor(
    private readonly db: Db,
    private readonly auth: Auth,
    private readonly kind: 'google' | 'fake',
  ) {}

  async account(userId: string) {
    const rows = await this.db
      .select({ id: accounts.id, scope: accounts.scope, accountId: accounts.accountId })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'google')));
    return rows.find((r) => hasDriveScope(r.scope)) ?? null;
  }

  async connected(userId: string) {
    return !!(await this.account(userId));
  }

  async get(userId: string): Promise<string> {
    const acc = await this.account(userId);
    if (!acc) throw new DriveError('invalid_grant', 'O Google Drive não está conectado nesta conta');
    if (this.kind === 'fake') return `fake:${userId}`;
    try {
      const r = (await this.auth.api.getAccessToken({ body: { accountId: acc.id, userId } })) as { accessToken?: string };
      if (!r?.accessToken) throw new Error('sem token');
      return r.accessToken;
    } catch {
      throw new DriveError('invalid_grant', 'Não foi possível renovar o acesso ao Google Drive');
    }
  }

  /** Modo fake: "conectar" grava a conta Google vinculada com o escopo do Drive, sem OAuth */
  async connectFake(userId: string) {
    if (this.kind !== 'fake') throw new Error('só no modo fake');
    if (await this.account(userId)) return;
    const now = new Date();
    await this.db.insert(accounts).values({
      id: `acc_fake_${userId}`,
      accountId: `fake-${userId}`,
      providerId: 'google',
      userId,
      scope: `openid email profile ${DRIVE_SCOPE}`,
      accessToken: 'fake',
      createdAt: now,
      updatedAt: now,
    });
  }
}
