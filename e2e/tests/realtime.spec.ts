import { expect, test, type Browser, type Page } from '@playwright/test';
import { signupAndVerify } from './auth';
import { addMember } from './db';

async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const email = await signupAndVerify(page, name);
  return { ctx, page, email };
}

async function createProject(page: Page, name: string) {
  await page.getByRole('button', { name: 'Novo projeto' }).click();
  await page.getByPlaceholder('Ex.: Loja').fill(name);
  await page.getByLabel('Exemplo (loja)').check();
  await page.getByRole('button', { name: 'Criar' }).click();
  await page.waitForSelector('.react-flow__node-table');
  const m = page.url().match(/\/p\/([^/]+)\/c\/([^/?#]+)/)!;
  return { projectId: m[1], canvasId: m[2], url: page.url() };
}

const tableNames = (p: Page) => p.evaluate(() => window.__erd.tableNames());

test('dois usuários editando o mesmo canvas e o mesmo painel SQL ao mesmo tempo', async ({ browser }) => {
  const a = await newUser(browser, 'Ana');
  const b = await newUser(browser, 'Bruno');
  const proj = await createProject(a.page, 'Colaborativo');
  await addMember(proj.projectId, b.email, 'editor');
  await b.page.goto(proj.url);
  await b.page.waitForSelector('.react-flow__node-table');
  await expect(b.page.getByTestId('connection')).toHaveText(/Salvo/);

  // A cria uma tabela pelo canvas → B vê em menos de 1 s
  await a.page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await a.page.keyboard.press('r');
  await a.page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await a.page.keyboard.type('fornecedores');
  const t0 = Date.now();
  await a.page.keyboard.press('Enter');
  await expect.poll(() => tableNames(a.page), { timeout: 3000, intervals: [50] }).toContain('fornecedores');
  await expect.poll(() => tableNames(b.page), { timeout: 3000, intervals: [50] }).toContain('fornecedores');
  expect(Date.now() - t0).toBeLessThan(1500);

  // A e B digitam no mesmo painel SQL, ao mesmo tempo, em pontos diferentes
  await a.page.locator('.cm-content').first().click();
  await a.page.keyboard.press('Control+Home');
  await b.page.locator('.cm-content').first().click();
  await b.page.keyboard.press('Control+End');
  await Promise.all([
    a.page.keyboard.type('CREATE TABLE tags (\n  id serial PRIMARY KEY\n);\n\n', { delay: 15 }),
    b.page.keyboard.type('\nCREATE TABLE logs (\nid serial PRIMARY KEY,\nmsg text\n);\n', { delay: 15 }),
  ]);
  for (const p of [a.page, b.page]) {
    await expect.poll(() => tableNames(p), { timeout: 10_000 }).toEqual(expect.arrayContaining(['tags', 'logs', 'fornecedores']));
  }
  const names = await tableNames(a.page);
  expect(names.filter((n) => n === 'tags')).toHaveLength(1);
  expect(names.filter((n) => n === 'logs')).toHaveLength(1);
  // os dois cursores aparecem no editor do outro
  // (o editor só desenha as linhas visíveis: rola até onde está o cursor do outro)
  await a.page.locator('.cm-scroller').first().evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect(a.page.locator('.cm-ySelectionInfo')).toContainText('Bruno');
  await b.page.locator('.cm-scroller').first().evaluate((e) => (e.scrollTop = 0));
  await expect(b.page.locator('.cm-ySelectionInfo')).toContainText('Ana');

  // offline em A → editar → reconectar → B recebe
  await a.ctx.setOffline(true);
  await expect(a.page.getByTestId('connection')).toHaveText(/Offline/, { timeout: 10_000 });
  await a.page.locator('.react-flow__pane').click({ position: { x: 400, y: 820 } });
  await a.page.keyboard.press('r');
  await a.page.locator('.react-flow__pane').click({ position: { x: 400, y: 820 } });
  await a.page.keyboard.type('offline_tab');
  await a.page.keyboard.press('Enter');
  await a.page.waitForTimeout(500);
  expect(await tableNames(b.page)).not.toContain('offline_tab');
  await a.ctx.setOffline(false);
  await expect.poll(() => tableNames(b.page), { timeout: 15_000 }).toContain('offline_tab');

  await a.ctx.close();
  await b.ctx.close();
});
