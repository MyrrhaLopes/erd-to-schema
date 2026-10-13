import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const executablePath = process.env.CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForSelector('.react-flow__node-table');
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const m = await import('/src/sync/parserClient.ts');
  const t0 = performance.now();
  const a = await m.parseInWorker('drizzle', 'while (true) {}');
  const t1 = performance.now();
  const b = await m.parseInWorker('drizzle', "import { pgTable, serial } from 'drizzle-orm/pg-core'; export const a = pgTable('a', { id: serial().primaryKey() });");
  return { a: a.ok ? 'ok' : a.diagnostics[0].message, ms: Math.round(t1 - t0), b: b.ok };
});
console.log(r);
await browser.close();
