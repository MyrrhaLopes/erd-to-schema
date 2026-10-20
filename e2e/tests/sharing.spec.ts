import { expect, test, type Browser, type Page } from '@playwright/test';
import { signupAndVerify } from './auth';
import { latestEmail, linkIn } from './mail';

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

test('viewer não edita, pede acesso; o dono aprova pelo link do e-mail e o viewer vira editor sem recarregar', async ({ browser }) => {
  const owner = await newUser(browser, 'Dona');
  const viewer = await newUser(browser, 'Leitor');
  const proj = await createProject(owner.page, 'Compartilhado');

  // o dono compartilha pelo diálogo, como leitor
  await owner.page.getByTestId('share').click();
  await owner.page.getByLabel('E-mail para compartilhar').fill(viewer.email);
  await owner.page.getByLabel('Papel do convite').selectOption('viewer');
  await owner.page.getByRole('button', { name: 'Convidar' }).click();
  await expect(owner.page.getByTestId('member-row')).toHaveCount(2);
  await expect(owner.page.getByTestId('member-row').nth(1)).toContainText('Leitor');
  await owner.page.keyboard.press('Escape');
  await owner.page.getByTitle('Fechar').click();

  // o viewer recebe o aviso por e-mail e abre o projeto em modo visualização
  const added = await latestEmail(viewer.email, 'Você foi adicionado a um projeto');
  // /p/:id redireciona para o primeiro canvas: espera só o início da navegação
  await viewer.page.goto(linkIn(added.text, `/p/${proj.projectId}`), { waitUntil: 'commit' });
  await viewer.page.waitForSelector('.react-flow__node-table');
  await expect(viewer.page.getByTestId('view-mode-banner')).toContainText('Você está no modo visualização');
  await expect(viewer.page.getByTestId('toolbar-readonly')).toBeVisible();
  await expect(viewer.page.getByTitle(/^Tabela/)).toHaveCount(0);
  const before = await tableNames(viewer.page);
  // atalhos de edição não fazem nada
  await viewer.page.locator('.react-flow__pane').click({ position: { x: 400, y: 700 } });
  await viewer.page.keyboard.press('r');
  await viewer.page.locator('.react-flow__pane').click({ position: { x: 400, y: 700 } });
  await viewer.page.keyboard.type('nao_pode');
  await viewer.page.keyboard.press('Enter');
  expect(await tableNames(viewer.page)).toEqual(before);
  // os painéis de código são só leitura
  await expect(viewer.page.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');

  // pede acesso de edição
  await viewer.page.getByRole('button', { name: 'Pedir acesso de edição' }).click();
  await viewer.page.getByPlaceholder(/Mensagem/).fill('preciso criar a tabela de fornecedores');
  await viewer.page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(viewer.page.getByTestId('view-mode-banner')).toContainText('aguardando aprovação');

  // o dono vê no sininho...
  await owner.page.reload();
  await expect(owner.page.getByTestId('unread')).toHaveText('1');
  await owner.page.getByTestId('notifications').click();
  await expect(owner.page.getByTestId('notification').first()).toContainText('Leitor pediu acesso de edição a Compartilhado');
  await owner.page.keyboard.press('Escape');

  // ...e aprova pelo link do e-mail
  const mail = await latestEmail(owner.email, 'Novo pedido de acesso de edição');
  expect(mail.text).toContain('preciso criar a tabela de fornecedores');
  await owner.page.goto(linkIn(mail.text, '/settings\\?request='));
  await expect(owner.page.getByTestId('access-request')).toContainText('Leitor');
  await owner.page.getByRole('button', { name: 'Aprovar' }).click();
  await expect(owner.page.getByText('Nenhum pedido pendente.')).toBeVisible();

  // o viewer vira editor sem recarregar: a faixa some e as ferramentas de edição voltam
  await expect(viewer.page.getByTestId('view-mode-banner')).toHaveCount(0, { timeout: 15_000 });
  await expect(viewer.page.getByTitle(/^Tabela/)).toHaveCount(1);
  await viewer.page.waitForSelector('.react-flow__node-table');
  await expect(viewer.page.getByTestId('connection')).toHaveText(/Salvo/);
  await viewer.page.locator('.react-flow__pane').click({ position: { x: 400, y: 700 } });
  await viewer.page.keyboard.press('r');
  await viewer.page.locator('.react-flow__pane').click({ position: { x: 400, y: 700 } });
  await viewer.page.keyboard.type('fornecedores');
  await viewer.page.keyboard.press('Enter');
  await expect.poll(() => tableNames(viewer.page)).toContain('fornecedores');

  // e o dono vê a tabela nova no canvas
  await owner.page.goto(proj.url);
  await expect.poll(() => tableNames(owner.page), { timeout: 10_000 }).toContain('fornecedores');

  await owner.ctx.close();
  await viewer.ctx.close();
});

test('convite por e-mail para quem ainda não tem conta', async ({ browser }) => {
  const owner = await newUser(browser, 'Dono');
  await createProject(owner.page, 'Convites');
  const guest = `novo.${Date.now().toString(36)}@e2e.test`;
  await owner.page.getByTestId('share').click();
  await owner.page.getByLabel('E-mail para compartilhar').fill(guest);
  await owner.page.getByRole('button', { name: 'Convidar' }).click();
  await expect(owner.page.getByTestId('invitation-row')).toContainText(guest);

  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const mail = await latestEmail(guest, 'Você foi convidado para um projeto');
  await page.goto(linkIn(mail.text, '/invite/'));
  await expect(page.getByText(/convidou/)).toContainText('Convites');
  await page.getByRole('link', { name: 'Criar conta' }).click();
  await page.getByLabel('Nome').fill('Convidada');
  await page.getByLabel('E-mail').fill(guest);
  await page.getByLabel(/Senha/).fill('senha-forte-123');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  const verify = await latestEmail(guest, 'Confirme seu e-mail');
  await page.goto(linkIn(verify.text, 'verify-email'));
  // o link de verificação volta para o convite
  await page.getByRole('button', { name: 'Aceitar e abrir o projeto' }).click();
  await page.waitForSelector('.react-flow__node-table');
  await expect(page.getByTestId('view-mode-banner')).toHaveCount(0);
  await ctx.close();
  await owner.ctx.close();
});
