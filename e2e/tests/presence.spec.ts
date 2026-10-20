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

// paleta de membros (packages/contracts): o dono fica com a cor 0 (rosa) e o próximo membro com a 1 (azul, rgb(37, 99, 235))
const ROSE = '#e11d48';

test('presença: cursor com nome e cor, anel de seleção, avatares, seguir, aviso de edição, rastro e autoria', async ({ browser }) => {
  const ana = await newUser(browser, 'Ana');
  const bia = await newUser(browser, 'Bia');
  const proj = await createProject(ana.page, 'Presença');
  await addMember(proj.projectId, bia.email, 'editor', 1);
  await bia.page.goto(proj.url);
  await bia.page.waitForSelector('.react-flow__node-table');
  await expect(bia.page.getByTestId('connection')).toHaveText(/Salvo/);

  // avatares de quem está online, na cor de cada um
  await expect(ana.page.getByTestId('peer-avatar')).toHaveCount(1);
  await expect(ana.page.getByTestId('peer-avatar')).toHaveAttribute('title', 'Seguir Bia');
  await expect(ana.page.getByTestId('peer-avatar')).toHaveCSS('background-color', 'rgb(37, 99, 235)');

  // cursor remoto com o nome e a cor de quem mexe
  await ana.page.mouse.move(700, 600);
  await ana.page.mouse.move(720, 610, { steps: 4 });
  const cursor = bia.page.getByTestId('remote-cursor');
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toContainText('Ana');
  await expect(cursor.locator('[data-color]')).toHaveAttribute('data-color', ROSE);

  // Ana seleciona uma tabela: Bia vê o anel na cor da Ana e o mini-avatar
  const customers = (p: Page) => p.locator('.react-flow__node-table').filter({ hasText: 'customers' });
  await customers(ana.page).locator('.erd-table').first().click({ position: { x: 60, y: 12 } });
  await expect(customers(bia.page).getByTestId('peer-ring')).toHaveCSS('border-top-color', 'rgb(225, 29, 72)');
  await expect(customers(bia.page).getByTestId('node-avatars')).toContainText('A');

  // a faixa na margem do SQL mostra quem está com a tabela selecionada
  await expect(bia.page.locator('.cm-line.erd-peer-block').first()).toBeAttached();

  // soft lock: Ana renomeia a tabela; Bia vê "Ana está editando"
  await ana.page.keyboard.press('Enter');
  await expect(customers(bia.page).getByTestId('soft-lock')).toHaveText('Ana está editando');
  await ana.page.keyboard.press('Escape');
  await expect(customers(bia.page).getByTestId('soft-lock')).toHaveCount(0);

  // rastro recente: a tabela que a Bia cria acende na cor dela na tela da Ana
  await bia.page.locator('.react-flow__pane').click({ position: { x: 400, y: 820 } });
  await bia.page.keyboard.press('r');
  await bia.page.locator('.react-flow__pane').click({ position: { x: 400, y: 820 } });
  await bia.page.keyboard.type('pagamentos');
  await bia.page.keyboard.press('Enter');
  const pagamentos = (p: Page) => p.locator('.react-flow__node-table').filter({ hasText: 'pagamentos' });
  await expect(pagamentos(ana.page).getByTestId('recent-change')).toHaveCount(1);
  await expect(pagamentos(ana.page).getByTestId('recent-change')).toHaveCSS('box-shadow', /rgb\(37, 99, 235\)/);

  // "Mostrar autoria": a tabela nova traz o nome de quem a editou por último
  await ana.page.getByRole('button', { name: /Visualização/ }).click();
  await ana.page.getByLabel('Mostrar autoria').check();
  await ana.page.keyboard.press('Escape');
  await expect(pagamentos(ana.page).getByTestId('authorship')).toHaveCSS('border-top-color', 'rgb(37, 99, 235)');
  await expect(pagamentos(ana.page).getByText(/^Bia ·/)).toBeVisible();

  // seguir: Bia segue a Ana e a tela dela acompanha
  await bia.page.getByTestId('peer-avatar').click();
  await expect(bia.page.getByTestId('follow-banner')).toContainText('Seguindo Ana');
  const zoom = (p: Page) => p.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
  await ana.page.mouse.move(500, 500);
  await ana.page.mouse.wheel(0, -400);
  await ana.page.waitForTimeout(400);
  const scale = async (p: Page) => Number((await zoom(p)).match(/scale\(([\d.]+)\)/)?.[1]);
  const target = await scale(ana.page);
  await expect.poll(async () => Math.abs((await scale(bia.page)) - target), { timeout: 5000 }).toBeLessThan(0.01);

  await ana.ctx.close();
  await bia.ctx.close();
});

test('rastro de digitação e erros com dono no painel SQL', async ({ browser }) => {
  const ana = await newUser(browser, 'Ana');
  const bia = await newUser(browser, 'Bia');
  const proj = await createProject(ana.page, 'Texto');
  await addMember(proj.projectId, bia.email, 'editor', 1);
  await bia.page.goto(proj.url);
  await bia.page.waitForSelector('.react-flow__node-table');
  await expect(bia.page.getByTestId('connection')).toHaveText(/Salvo/);

  // Bia digita um bloco quebrado no fim do SQL
  await bia.page.locator('.cm-content').first().click();
  await bia.page.keyboard.press('Control+End');
  await ana.page.locator('.cm-scroller').first().evaluate((e) => (e.scrollTop = e.scrollHeight));
  const typing = bia.page.keyboard.type('\nCREATE TABLE quebrada (\n  id serial PRIMARY KEY,\n', { delay: 40 });
  // Ana vê o rastro na cor da Bia enquanto ela digita
  await expect(ana.page.locator('.erd-typing-trail[style*="#2563eb"]').first()).toBeAttached();
  await typing;
  // e, quando o bot registra o erro, ele aparece para a Ana como "em edição por Bia"
  await bia.page.keyboard.press('Control+s');
  await expect(ana.page.getByTestId('diagnostics')).toContainText('Em edição por Bia', { timeout: 15_000 });
  await expect(bia.page.getByTestId('diagnostics')).not.toContainText('Em edição por');
  // e a Bia aparece na aba SQL para a Ana
  await expect(ana.page.getByTestId('tab-peers-sql')).toBeVisible();

  // ponte painel ⇄ canvas: o cursor da Ana dentro do CREATE TABLE customers acende a tabela na cor dela para a Bia,
  // e "Ver no diagrama" seleciona a tabela no canvas da Ana
  await ana.page.locator('.cm-scroller').first().evaluate((e) => (e.scrollTop = 0));
  await ana.page.locator('.cm-line', { hasText: 'CREATE TABLE customers' }).click();
  const customers = (p: typeof ana.page) => p.locator('.react-flow__node-table').filter({ hasText: 'customers' });
  await expect(customers(bia.page).getByTestId('peer-ring')).toHaveCSS('border-top-color', 'rgb(225, 29, 72)');
  await ana.page.getByTestId('reveal-in-canvas').click();
  await expect(customers(ana.page)).toHaveClass(/selected/);

  await ana.ctx.close();
  await bia.ctx.close();
});
