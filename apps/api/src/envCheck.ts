// `pnpm env:check`: valida o .env com o mesmo zod do boot
import { loadEnv } from './env';

try {
  const env = loadEnv();
  console.log(`✔ variáveis ok (NODE_ENV=${env.NODE_ENV}, MAIL_DRIVER=${env.MAIL_DRIVER})`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
