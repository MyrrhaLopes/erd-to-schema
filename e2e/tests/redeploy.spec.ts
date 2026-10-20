import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { signupAndVerify } from './auth';

/**
 * Redeploy no meio de uma edição (§15.8, fase 3): o servidor recebe SIGTERM, grava os
 * documentos pendentes e fecha os WebSockets; o cliente reconecta e nada se perde.
 * Só roda contra o prod:local: REDEPLOY_CMD="docker compose --profile prod restart server".
 */
test.skip(!process.env.REDEPLOY_CMD, 'defina REDEPLOY_CMD para rodar');

test('reiniciar o servidor no meio de uma edição não perde nada', async ({ page }) => {
  test.setTimeout(180_000);
  await signupAndVerify(page, 'Rita');
  await page.getByRole('button', { name: 'Novo projeto' }).click();
  await page.getByPlaceholder('Ex.: Loja').fill('Redeploy');
  await page.getByLabel('Exemplo (loja)').check();
  await page.getByRole('button', { name: 'Criar' }).click();
  await page.waitForSelector('.react-flow__node-table');

  const create = async (name: string, x: number) => {
    await page.locator('.react-flow__pane').click({ position: { x, y: 820 } });
    await page.keyboard.press('r');
    await page.locator('.react-flow__pane').click({ position: { x, y: 820 } });
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
  };

  // edição logo antes do SIGTERM: ainda dentro do debounce do store (2 s)
  await create('antes_do_deploy', 150);
  await page.waitForTimeout(300);
  execSync(process.env.REDEPLOY_CMD!, { stdio: 'inherit' });
  // durante a volta do servidor a edição fica local e é reenviada ao reconectar
  await create('durante_o_deploy', 420);
  await expect(page.getByTestId('connection')).toHaveText(/Salvo/, { timeout: 60_000 });

  // recarrega sem o cache local: o que veio do servidor tem as duas tabelas
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
  });
  await page.reload();
  await page.waitForSelector('.react-flow__node-table');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames()), { timeout: 20_000 }).toEqual(expect.arrayContaining(['antes_do_deploy', 'durante_o_deploy']));
});
