import { expect, test, type Browser, type Page } from '@playwright/test';
import { signupAndVerify } from './auth';
import { addMember } from './db';

async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const email = await signupAndVerify(page, name);
  return { ctx, page, email };
}

const tableNames = (p: Page) => p.evaluate(() => window.__erd.tableNames());

test('salvar versão, editar, restaurar (ao vivo para todos) e desfazer a restauração', async ({ browser }) => {
  const ana = await newUser(browser, 'Ana');
  const bia = await newUser(browser, 'Bia');
  await ana.page.getByRole('button', { name: 'Novo projeto' }).click();
  await ana.page.getByPlaceholder('Ex.: Loja').fill('Versionado');
  await ana.page.getByLabel('Exemplo (loja)').check();
  await ana.page.getByRole('button', { name: 'Criar' }).click();
  await ana.page.waitForSelector('.react-flow__node-table');
  const projectId = ana.page.url().match(/\/p\/([^/]+)\//)![1];
  await addMember(projectId, bia.email, 'editor', 1);
  await bia.page.goto(ana.page.url());
  await bia.page.waitForSelector('.react-flow__node-table');
  await expect(ana.page.getByTestId('thumbnail')).toHaveCount(0); // só no dashboard

  // salva uma versão
  await ana.page.getByTestId('versions-button').click();
  await ana.page.getByLabel('Nome da versão').fill('antes da limpeza');
  await ana.page.getByRole('button', { name: 'Salvar versão' }).click();
  await expect(ana.page.getByTestId('version-row').filter({ hasText: 'antes da limpeza' })).toHaveCount(1);
  await ana.page.getByTitle('Fechar').click();

  // apaga uma tabela
  const before = await tableNames(ana.page);
  await ana.page.locator('.react-flow__node-table').filter({ hasText: 'categories' }).first().click({ position: { x: 60, y: 12 } });
  await ana.page.keyboard.press('Delete');
  await expect.poll(() => tableNames(bia.page)).not.toContain('categories');

  // restaura: volta para todos, e a Bia é avisada
  ana.page.once('dialog', (d) => void d.accept());
  await ana.page.getByTestId('versions-button').click();
  await ana.page.getByTestId('version-row').filter({ hasText: 'antes da limpeza' }).getByRole('button', { name: 'Restaurar' }).click();
  await expect.poll(() => tableNames(ana.page)).toEqual(expect.arrayContaining(before));
  await expect.poll(() => tableNames(bia.page)).toContain('categories');
  await expect(bia.page.getByText('Ana restaurou a versão "antes da limpeza"')).toBeVisible();

  // Ctrl+Z desfaz a restauração inteira
  await ana.page.locator('.react-flow__pane').click({ position: { x: 400, y: 820 } });
  await ana.page.keyboard.press('Control+z');
  await expect.poll(() => tableNames(bia.page)).not.toContain('categories');

  // a miniatura aparece no dashboard
  await ana.page.goto('/');
  await expect(ana.page.getByTestId('thumbnail').first()).toBeVisible();
  await expect.poll(() => ana.page.getByTestId('thumbnail').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await ana.ctx.close();
  await bia.ctx.close();
});
