import { expect, test } from '@playwright/test';
import { openLocal, sqlText } from './helpers';

test('carrega o exemplo com tabelas, arestas e o SQL gerado', async ({ page }) => {
  const errors = await openLocal(page);
  expect(await page.locator('.react-flow__node-table').count()).toBeGreaterThan(3);
  expect(await page.locator('.react-flow__edge').count()).toBeGreaterThan(3);
  expect(await sqlText(page)).toContain('CREATE TABLE customers');
  expect(errors).toEqual([]);
});

test('o .wasm do parser é servido com o content-type correto', async ({ page, request }) => {
  await openLocal(page);
  const wasm = await page.evaluate(() => new URL(window.__erd.wasmUrl, location.href).href);
  expect(wasm).toBeTruthy();
  const res = await request.get(wasm!);
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toContain('application/wasm');
});
