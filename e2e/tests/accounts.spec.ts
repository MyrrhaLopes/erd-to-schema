import { expect, test, type Page } from '@playwright/test';
import { latestEmail, linkIn, uniqueEmail } from './mail';

export async function signupAndVerify(page: Page, name: string) {
  const email = uniqueEmail(name.toLowerCase());
  await page.goto('/signup');
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel(/Senha/).fill('senha-forte-123');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page.getByText('Confirme seu e-mail')).toBeVisible();
  const mail = await latestEmail(email, 'Confirme seu e-mail');
  await page.goto(linkIn(mail.text, 'verify-email'));
  await expect(page.getByTestId('me')).toHaveText(name);
  return email;
}

test('criar conta (e-mail de verificação chega no Mailpit), criar projeto, editar, recarregar e ver o estado salvo', async ({ page }) => {
  await signupAndVerify(page, 'Ana');
  await page.getByRole('button', { name: 'Novo projeto' }).click();
  await page.getByPlaceholder('Ex.: Loja').fill('Loja da Ana');
  await page.getByLabel('Exemplo (loja)').check();
  await page.getByRole('button', { name: 'Criar' }).click();
  await page.waitForSelector('.react-flow__node-table');
  await expect(page.getByTestId('connection')).toHaveText(/Salvo/);

  // edita no canvas: nova tabela
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('r');
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.type('fornecedores');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('fornecedores');
  await expect(page.getByTestId('connection')).toHaveText(/Salvo/, { timeout: 10_000 });

  // recarrega com o cache local apagado: o estado vem do servidor
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
  });
  await page.reload();
  await page.waitForSelector('.react-flow__node-table');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('fornecedores');

  // volta ao dashboard: o projeto está lá
  await page.getByTestId('back-to-dashboard').click();
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  await expect(page.getByTestId('project-card')).toContainText('Loja da Ana');
});

test('login com senha errada, esqueci a senha e redefinição pelo link do e-mail', async ({ page }) => {
  const email = await signupAndVerify(page, 'Bruno');
  await page.getByTitle('Sair').click();
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill('errada-errada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('E-mail ou senha incorretos')).toBeVisible();

  await page.getByText('Esqueci a senha').click();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Enviar link' }).click();
  await expect(page.getByText(/enviamos um link/)).toBeVisible();
  const mail = await latestEmail(email, 'Redefinir senha');
  await page.goto(linkIn(mail.text, 'reset-password'));
  await page.getByLabel('Nova senha').fill('nova-senha-456');
  await page.getByRole('button', { name: 'Salvar senha' }).click();
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill('nova-senha-456');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByTestId('me')).toHaveText('Bruno');
});

test('a raiz exige login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});
