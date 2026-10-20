// usado só em dev/CI (drizzle-kit generate | studio); a produção roda src/migrate.ts no pre-deploy
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://erd:erd@localhost:5432/erd' },
  strict: true,
});
