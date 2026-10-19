import { expect, test } from '@playwright/test';
import { appendEditorText, openLocal, panel, sqlText } from './helpers';

test('edição no canvas enquanto o SQL tem erro: o texto do usuário não é perdido', async ({ page }) => {
  await openLocal(page);
  await appendEditorText(page, '\nCREATE TABLE broken (');
  await expect.poll(async () => (await panel(page, 'sql')).status).toBe('error');

  // muda o modelo pelo canvas
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('r');
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('nova_tabela');

  // conserta o SQL: as duas mudanças sobrevivem
  await appendEditorText(page, 'id int);');
  const apply = page.getByRole('button', { name: 'Aplicar minha versão' });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('broken');
  expect(await sqlText(page)).toContain('CREATE TABLE broken');
});
