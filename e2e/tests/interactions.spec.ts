import { expect, test } from '@playwright/test';
import { appendEditorText, node, openLocal, panel, replaceEditorText, sqlText, tables, waitSynced } from './helpers';

test('fluxo principal: Ctrl+Seta, painéis, erros, undo, borracha, filtros e exports', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  const errors = await openLocal(page);
  const initial = await tables(page);

  // Ctrl+Seta cria tabela relacionada com FK
  await node(page, 'customers').locator('span:text-is("customers")').click();
  await page.keyboard.press('Control+ArrowRight');
  await expect.poll(() => tables(page)).toBe(initial + 1);
  await page.keyboard.type('invoices');
  await page.keyboard.press('Enter');
  await expect.poll(() => sqlText(page)).toContain('CREATE TABLE invoices');
  expect(await sqlText(page)).toMatch(/invoices[\s\S]*customer_id integer NOT NULL/);

  // Prisma reflete e aceita edição
  await page.getByRole('button', { name: 'Prisma', exact: true }).click();
  const prisma = await waitSynced(page, 'prisma');
  expect(prisma.text).toContain('model Invoice');
  await replaceEditorText(page, prisma.text.replace('model Invoice {\n', 'model Invoice {\n  total Decimal @db.Decimal(10, 2)\n'));
  await expect.poll(() => sqlText(page)).toContain('total numeric(10,2)');
  const sql = await sqlText(page);
  expect(sql).toContain('products_price_positive CHECK (price_cents >= 0)');
  expect(sql).toContain('WHERE referral_code IS NOT NULL');
  await expect(node(page, 'invoices').locator('text=total')).toHaveCount(1);

  // erro de sintaxe no Prisma não altera o modelo
  const before = await tables(page);
  await appendEditorText(page, '\nmodel Broken {');
  await expect.poll(async () => (await panel(page, 'prisma')).status).toBe('error');
  expect(await tables(page)).toBe(before);
  await page.keyboard.insertText('\n  id Int @id\n}');
  await expect.poll(() => tables(page)).toBe(before + 1);

  // Drizzle com helper e spread
  await page.getByRole('button', { name: 'Drizzle', exact: true }).click();
  const dz = await waitSynced(page, 'drizzle');
  expect(dz.text).toContain("pgTable('Broken'");
  expect(dz.text).toContain("numeric('total', { precision: 10, scale: 2 })");
  let nd = dz.text.replace("export const broken = pgTable('Broken', {", "const ts = { createdAt: timestamp('created_at').defaultNow() };\nexport const broken = pgTable('Broken', {\n  ...ts,");
  if (!/\btimestamp\b,/.test(nd.split('\n')[0])) nd = nd.replace('import { ', 'import { timestamp, ');
  await replaceEditorText(page, nd);
  await expect.poll(() => sqlText(page), { timeout: 15_000 }).toMatch(/"Broken"[\s\S]*created_at timestamp DEFAULT now\(\)/);

  // Ctrl+Z no editor desfaz a digitação, e o bot reaplica o resultado no modelo
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => sqlText(page), { timeout: 15_000 }).not.toMatch(/"Broken"[\s\S]*created_at/);

  // Ctrl+Z no canvas desfaz a última mudança feita no canvas (aqui: a tabela criada com Ctrl+Seta)
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 800 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).not.toContain('invoices');
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => page.evaluate(() => window.__erd.tableNames())).toContain('invoices');

  // borracha
  await page.keyboard.press('Shift+!');
  await page.waitForTimeout(400);
  await page.keyboard.press('e');
  const box = (await node(page, 'Broken').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 18, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('v');
  await expect(node(page, 'Broken')).toHaveCount(0);

  // filtros: esconder pivots vira aresta N:N
  await page.getByRole('button', { name: /Visualização/ }).click();
  await page.getByLabel('Tabelas pivot (N:N)').uncheck();
  await expect(page.locator('.react-flow__edge[data-id^="nn:"]')).not.toHaveCount(0);
  await page.getByLabel('Tabelas pivot (N:N)').check();
  await page.getByRole('button', { name: /Visualização/ }).click();

  // exports
  await node(page, 'orders_history').locator('span:text-is("orders_history")').click();
  await node(page, 'customers').locator('span:text-is("customers")').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: /PNG\/PDF/ }).click();
  const [png] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar PNG' }).click()]);
  expect(png.suggestedFilename()).toMatch(/\.png$/);
  await page.getByRole('button', { name: /PNG\/PDF/ }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const [zip] = await Promise.all([page.waitForEvent('download'), page.locator('button[title="Salvar projeto (.zip)"]').click()]);
  expect(zip.suggestedFilename()).toMatch(/\.erd\.zip$/);

  expect(errors).toEqual([]);
});
