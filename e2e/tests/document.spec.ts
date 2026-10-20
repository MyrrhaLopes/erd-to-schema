import { expect, test, type Browser } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { signupAndVerify } from './auth';
import { addMember } from './db';
import { appendEditorText, openLocal, waitSynced } from './helpers';

/**
 * Documento Word no Drive (drive-docx-plan §11, E2E) com DRIVE_PROVIDER=fake: tags de módulo,
 * formulário, tela de revisão, publicar, o toast no outro navegador, reverter, trocar pasta
 * e transferir a posse. O Picker vira um seletor simples no modo fake.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
});

async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  const page = await ctx.newPage();
  const email = await signupAndVerify(page, name);
  return { ctx, page, email };
}

const docxText = (path: string) => strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);

test('modo local: módulos por tag, formulário, revisão e Baixar .docx', async ({ page }) => {
  await openLocal(page);
  await appendEditorText(page, '\n-- @erd:tags customers "Módulo A — Clientes"\n');
  await page.keyboard.press('Control+s');
  await waitSynced(page, 'sql');

  await page.getByRole('button', { name: 'Documento' }).click();
  const form = page.getByTestId('doc-form');
  await expect(form).toBeVisible();
  await form.getByPlaceholder('Modelo de Dados').fill('Dicionário da Loja');
  await form.getByPlaceholder('Modelo de Dados').press('Enter');
  await expect(page.getByTestId('doc-preview')).toContainText('Dicionário da Loja');
  await expect(page.getByTestId('doc-preview')).toContainText('Módulo A — Clientes');
  // a descrição da tabela vai para o modelo (COMMENT ON no SQL)
  const customers = form.getByTestId('doc-table').filter({ hasText: 'customers' });
  await customers.locator('textarea').first().fill('Quem compra na loja');
  await customers.locator('textarea').first().blur();
  await expect.poll(async () => (await waitSynced(page, 'sql')).text).toContain("COMMENT ON TABLE customers IS 'Quem compra na loja'");

  await page.getByTestId('doc-review').click();
  await expect(page.getByTestId('review-modules')).toContainText('Módulo A');
  await expect(page.getByTestId('review-modules')).toContainText('Outras tabelas');
  await expect(page.getByTestId('publish')).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('review-download').click()]);
  expect(dl.suggestedFilename()).toMatch(/^Modelo_Dados_.*\.docx$/);
  const xml = docxText(await dl.path());
  expect(xml).toContain('Dicionário da Loja');
  expect(xml).toContain('Quem compra na loja');
});

test('Drive: conectar, publicar, toast para o colega, reverter, trocar pasta e transferir a posse', async ({ browser }) => {
  const ana = await newUser(browser, 'Ana');
  const bia = await newUser(browser, 'Bia');
  await ana.page.getByRole('button', { name: 'Novo projeto' }).click();
  await ana.page.getByPlaceholder('Ex.: Loja').fill('Documento');
  await ana.page.getByLabel('Exemplo (loja)').check();
  await ana.page.getByRole('button', { name: 'Criar' }).click();
  await ana.page.waitForSelector('.react-flow__node-table');
  const projectId = ana.page.url().match(/\/p\/([^/]+)\//)![1];
  await addMember(projectId, bia.email, 'editor', 1);
  await bia.page.goto(ana.page.url());
  await bia.page.waitForSelector('.react-flow__node-table');

  // tag de módulo pelo SQL
  await appendEditorText(ana.page, '\n-- @erd:tags orders "Módulo B — Pedidos"\n');
  await ana.page.keyboard.press('Control+s');
  await waitSynced(ana.page, 'sql');

  // conectar o Drive (fake) e escolher a pasta
  await ana.page.getByRole('button', { name: 'Documento' }).click();
  await ana.page.getByTestId('doc-tab-drive').click();
  await ana.page.getByTestId('drive-connect').click();
  await expect(ana.page.getByTestId('drive-account')).toBeVisible();
  await ana.page.getByTestId('drive-choose-folder').click();
  await ana.page.getByTestId('fake-picker').getByRole('button', { name: 'Projetos' }).click();
  await expect(ana.page.getByTestId('drive-folder')).toContainText('Projetos');
  await ana.page.getByTitle('Fechar').first().click();

  // publicar v1 pela tela de revisão
  await ana.page.getByTestId('save-to-drive').click();
  await expect(ana.page.getByTestId('review-modules')).toContainText('Módulo B');
  await expect(ana.page.getByTestId('review-pending')).toBeVisible();
  await ana.page.getByTestId('publish').click();
  await expect(ana.page.getByTestId('drive-version')).toContainText('v1');
  await expect(bia.page.getByText('Ana publicou a v1 no Drive')).toBeVisible();

  // a Bia (editora) muda a descrição de uma tabela no formulário: o ponto de "não publicado" aparece
  await bia.page.getByRole('button', { name: 'Documento' }).click();
  const orders = bia.page.getByTestId('doc-form').getByTestId('doc-table').filter({ hasText: 'orders' });
  await orders.locator('textarea').first().fill('Pedidos da loja');
  await orders.locator('textarea').first().blur();
  await bia.page.getByTitle('Fechar').first().click();
  await expect(ana.page.getByTestId('drive-dirty')).toBeVisible();
  await bia.page.getByTestId('save-to-drive').click();
  await bia.page.getByTestId('publish').click();
  await expect(ana.page.getByText('Bia publicou a v2 no Drive')).toBeVisible();
  await expect(ana.page.getByTestId('drive-version')).toContainText('v2');

  // reverter para a v1: o canvas volta e sai a v3
  ana.page.on('dialog', (d) => void d.accept());
  await ana.page.getByTestId('versions-button').click();
  await ana.page.getByTestId('versions-tab-drive').click();
  await ana.page.getByTestId('publication-row').filter({ hasText: 'v1 publicada' }).getByTestId('revert').click();
  await expect(ana.page.getByText('revertendo da v1')).toBeVisible();
  await expect(ana.page.getByTestId('review-preview')).toContainText('Pedidos feitos pelos clientes');
  await expect(ana.page.getByTestId('review-preview')).not.toContainText('Pedidos da loja');
  await ana.page.getByTestId('publish').click();
  await expect(ana.page.getByTestId('drive-version')).toContainText('v3');
  await ana.page.getByTestId('versions-button').click();
  await ana.page.getByTestId('versions-tab-drive').click();
  await expect(ana.page.getByTestId('publication-row').first()).toContainText('v3 publicada por Ana (reversão da v1)');
  await ana.page.getByTitle('Fechar').first().click();

  // trocar a pasta (só o dono)
  await ana.page.getByRole('button', { name: 'Documento' }).click();
  await ana.page.getByTestId('doc-tab-drive').click();
  await ana.page.getByTestId('drive-change-folder').click();
  await ana.page.getByTestId('fake-picker').getByRole('button', { name: 'Arquivo morto' }).click();
  await expect(ana.page.getByTestId('drive-folder')).toContainText('Arquivo morto');
  await ana.page.getByTitle('Fechar').first().click();

  // a Bia não vê os botões do dono
  await bia.page.getByRole('button', { name: 'Documento' }).click();
  await bia.page.getByTestId('doc-tab-drive').click();
  await expect(bia.page.getByTestId('gateway-warning')).toBeVisible();
  await expect(bia.page.getByTestId('drive-change-folder')).toHaveCount(0);
  await bia.page.getByTitle('Fechar').first().click();

  // transferir a posse: o documento fica no Drive da Ana até a Bia escolher uma pasta
  await ana.page.goto(`/p/${projectId}/settings`);
  await ana.page.getByLabel('Novo dono').selectOption({ label: 'Bia' });
  await ana.page.getByRole('button', { name: 'Transferir' }).click();
  await expect(ana.page.getByText('Bia agora é o dono')).toBeVisible();
  bia.page.on('dialog', (d) => void d.accept());
  await bia.page.goto(`/p/${projectId}/settings`);
  await expect(bia.page.getByTestId('drive-status')).toContainText('mudou de dono');
  await bia.page.getByTestId('drive-connect').click();
  await bia.page.getByTestId('drive-change-folder').click();
  await bia.page.getByTestId('fake-picker').getByRole('button').first().click();
  await expect(bia.page.getByTestId('drive-status')).toHaveCount(0);

  await ana.ctx.close();
  await bia.ctx.close();
});
