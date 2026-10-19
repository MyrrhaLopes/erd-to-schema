import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * O mesmo conjunto roda contra `pnpm dev` (padrão: sobe o Vite) e contra `pnpm prod:local`
 * (URL=http://localhost:8081 pnpm e2e), que serve as imagens reais.
 */
const baseURL = process.env.URL ?? 'http://localhost:5173';
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
    : {
        command: 'pnpm --filter @erd/web dev --port 5173 --strictPort',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
