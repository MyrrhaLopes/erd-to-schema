// `pnpm auth:encrypt-tokens`: cifra os tokens OAuth gravados em texto puro antes de
// `account.encryptOAuthTokens` (drive-docx-plan §2.1). Roda uma vez; é idempotente.
import { symmetricEncrypt } from 'better-auth/crypto';
import { accounts, createDb, eq } from '@erd/db';
import { loadEnv } from '../env';

/** O mesmo teste do Better Auth para "já está cifrado" */
const encrypted = (t: string) => t.startsWith('$ba$') || (t.length % 2 === 0 && /^[0-9a-f]+$/i.test(t));

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL, { max: 1 });
let changed = 0;
try {
  for (const a of await db.select({ id: accounts.id, accessToken: accounts.accessToken, refreshToken: accounts.refreshToken }).from(accounts)) {
    const patch: { accessToken?: string; refreshToken?: string } = {};
    if (a.accessToken && !encrypted(a.accessToken)) patch.accessToken = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: a.accessToken });
    if (a.refreshToken && !encrypted(a.refreshToken)) patch.refreshToken = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: a.refreshToken });
    if (!Object.keys(patch).length) continue;
    await db.update(accounts).set(patch).where(eq(accounts.id, a.id));
    changed++;
  }
  console.log(`✔ ${changed} conta(s) com tokens cifrados agora`);
} finally {
  await pool.end();
}
