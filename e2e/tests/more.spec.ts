import { expect, test } from '@playwright/test';
import { node, openLocal, sqlText } from './helpers';

test('relações por clique e por arraste, notas, nova tabela e persistência', async ({ page }) => {
  await openLocal(page);

  // ferramenta relação: clique-clique N:N
  await page.keyboard.press('a');
  await page.getByRole('button', { name: 'N:N', exact: true }).click();
  await node(page, 'customers').locator('span:text-is("customers")').click();
  await node(page, 'products').locator('span:text-is("products")').click();
  await expect.poll(() => sqlText(page)).toMatch(/CREATE TABLE customer_products \(\n {2}customer_id integer,\n {2}product_id integer,\n {2}PRIMARY KEY \(customer_id, product_id\)/);

  // arrastar entre colunas cria FK
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const src = node(page, 'orders').locator('div', { hasText: /^referral_code/ }).locator('.react-flow__handle-right').first();
  const dst = node(page, 'customers').locator('div', { hasText: /^email/ }).locator('.react-flow__handle-left').first();
  const a = (await src.boundingBox())!;
  const b = (await dst.boundingBox())!;
  await page.mouse.move(a.x + 3, a.y + 3);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 3, { steps: 5 });
  await page.mouse.move(b.x + 3, b.y + 3, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => sqlText(page)).toMatch(/FOREIGN KEY \(referral_code\) REFERENCES customers \(email\)/);

  // nota em Markdown
  const note = page.locator('.react-flow__node-note').first();
  await note.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('# Título\n\n- item **forte**');
  await page.keyboard.press('Control+Enter');
  await expect(note.locator('h1')).toHaveCount(1);
  await expect(note.locator('strong')).toHaveCount(1);

  // ferramenta tabela
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('r');
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
  await page.keyboard.press('Escape');
  await expect.poll(() => sqlText(page)).toContain('CREATE TABLE nova_tabela');

  // recarregar mantém tudo
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector('.react-flow__node-table');
  await expect.poll(() => sqlText(page)).toContain('customer_products');
  expect(await sqlText(page)).toContain('nova_tabela');
  await expect(page.locator('.react-flow__node-note h1')).toHaveCount(1);
});
