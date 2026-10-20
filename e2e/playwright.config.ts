import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * O mesmo conjunto roda contra `pnpm dev` (padrão: sobe o Vite) e contra `pnpm prod:local`
 * (URL=http://localhost:8081 pnpm e2e), que serve as imagens reais.
 */
const baseURL = process.env.URL ?? 'http://localhost:5173';
const dbUrl = (() => {
  const u = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://erd:erd@localhost:5432/erd');
  u.pathname = '/erd_e2e';
  return u.toString();
})();
const executablePath = process.env.CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: './artifacts',
  use: {
    baseURL,
    viewport: { width: 1600, height: 950 },
    trace: 'retain-on-failure',
    acceptDownloads: true,
    launchOptions: { executablePath },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 950 } } }],
  webServer: process.env.URL
    ? undefined
    : [
        {
          command: 'pnpm exec tsx prepare-db.ts && pnpm --filter @erd/api... --filter !@erd/web run build && node --enable-source-maps ../apps/api/dist/main.js',
          url: 'http://localhost:8080/readyz',
          stdout: 'pipe',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            NODE_ENV: 'test',
            PORT: '8080',
            APP_URL: baseURL,
            BETTER_AUTH_URL: baseURL,
            DATABASE_URL: dbUrl,
            BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
            COLLAB_JWT_SECRET: 'e2e-collab-e2e-collab-e2e-collab-e2e',
            MAIL_DRIVER: 'smtp',
            SMTP_URL: process.env.SMTP_URL ?? 'smtp://localhost:1025',
            LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
            DRIVE_PROVIDER: 'fake',
          },
        },
        {
          command: 'pnpm --filter @erd/web dev --port 5173 --strictPort',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
