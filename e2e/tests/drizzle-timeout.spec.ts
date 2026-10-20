import { expect, test } from '@playwright/test';
import { openLocal } from './helpers';

test('loop infinito no Drizzle estoura o tempo e o worker volta a funcionar', async ({ page }) => {
  await openLocal(page);
  await page.waitForTimeout(1000);
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const a = await window.__erd.parse('drizzle', 'while (true) {}');
    const ms = performance.now() - t0;
    const b = await window.__erd.parse('drizzle', "import { pgTable, serial } from 'drizzle-orm/pg-core'; export const a = pgTable('a', { id: serial().primaryKey() });");
    return { a: a.ok ? 'ok' : a.diagnostics![0].message, ms, b: b.ok };
  });
  expect(r.a).toMatch(/Tempo esgotado/);
  expect(r.ms).toBeLessThan(9000);
  expect(r.b).toBe(true);
});
