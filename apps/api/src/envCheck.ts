// `pnpm env:check`: valida o .env com o mesmo zod do boot
import { driveMissing, driveProviderKind, loadEnv } from './env';

try {
  const env = loadEnv();
  console.log(`✔ variáveis ok (NODE_ENV=${env.NODE_ENV}, MAIL_DRIVER=${env.MAIL_DRIVER})`);
  const drive = driveProviderKind(env);
  console.log(drive ? `✔ Google Drive ligado (${drive})` : `– Google Drive desligado; faltam: ${driveMissing(env).join(', ')}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
