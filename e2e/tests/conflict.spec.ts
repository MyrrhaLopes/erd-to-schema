import { expect, test } from '@playwright/test';
import { appendEditorText, openLocal, panel, sqlText } from './helpers';

test('edição no canvas enquanto o SQL tem um bloco com erro: as duas mudanças sobrevivem', async ({ page }) => {
  await openLocal(page);
  await appendEditorText(page, '\nCREATE TABLE broken (');
  await expect.poll(async () => (await panel(page, 'sql')).status).toBe('error');

  // muda o modelo pelo canvas
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('r');
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('nova_tabela');

  // o bloco quebrado não impediu o canvas de atualizar o SQL, e o texto do usuário continua lá
  await expect.poll(() => sqlText(page)).toContain('CREATE TABLE nova_tabela');
  expect(await sqlText(page)).toContain('CREATE TABLE broken (');

  // conserta o SQL: as duas mudanças sobrevivem
  await appendEditorText(page, 'id int);');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('broken');
  expect(await page.evaluate(() => window.__erd.tableNames())).toContain('nova_tabela');
  await expect.poll(async () => (await panel(page, 'sql')).status).toBe('synced');
  expect(await sqlText(page)).toContain('CREATE TABLE broken');
});
