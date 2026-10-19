import { expect, type Page } from '@playwright/test';

export type Format = 'sql' | 'prisma' | 'drizzle';
interface PanelView {
  text: string;
  status: string;
  conflict: boolean;
  diags: string[];
}

declare global {
  interface Window {
    __erd: {
      panel: (f: Format) => PanelView;
      tableNames: () => string[];
      wasmUrl: string;
      parse: (f: Format, text: string) => Promise<{ ok: boolean; diagnostics?: { message: string }[] }>;
    };
  }
}

/** Abre o editor no modo local (sem conta) e espera o exemplo carregar */
export async function openLocal(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForSelector('.react-flow__node-table', { timeout: 30_000 });
  await page.waitForTimeout(500);
  return errors;
}

export const panel = (page: Page, f: Format) => page.evaluate((f) => window.__erd.panel(f), f);
export const sqlText = async (page: Page) => (await panel(page, 'sql')).text;
export const tables = (page: Page) => page.locator('.react-flow__node-table').count();
export const node = (page: Page, name: string) => page.locator('.react-flow__node-table').filter({ has: page.locator(`span:text-is("${name}")`) });

/** Espera o painel ficar sincronizado e devolve o texto */
export async function waitSynced(page: Page, f: Format) {
  await expect.poll(async () => (await panel(page, f)).status, { timeout: 10_000 }).toBe('synced');
  return panel(page, f);
}

/** Substitui todo o texto do editor de código visível */
export async function replaceEditorText(page: Page, text: string) {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}

export async function appendEditorText(page: Page, text: string) {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}
