import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const executablePath = process.env.CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const out = process.env.OUT ?? '.';
const browser = await chromium.launch({ executablePath });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (s) => console.log('▶', s);
const tables = () => page.locator('.react-flow__node-table').count();
const sqlText = () => page.evaluate(async () => (await import('/src/sync/engine.ts')).usePanels.getState().panels.sql.text);
const panel = (f) => page.evaluate(async (f) => { const p = (await import('/src/sync/engine.ts')).usePanels.getState().panels[f]; return { status: p.status, conflict: p.conflict, diags: p.diagnostics.map(d => d.message), text: p.text }; }, f);

await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForSelector('.react-flow__node-table');
await page.waitForTimeout(800);
step('initial tables: ' + await tables());

step('Ctrl+ArrowRight from customers');
await page.locator('.react-flow__node-table', { hasText: 'customers' }).locator('text=customers').first().click();
await page.keyboard.press('Control+ArrowRight');
await page.waitForTimeout(300);
step('tables after: ' + await tables());
await page.keyboard.type('invoices');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
let sql = await sqlText();
step('SQL has invoices: ' + sql.includes('CREATE TABLE invoices') + ', fk col: ' + /invoices[\s\S]*customer_id integer NOT NULL/.test(sql));
await page.screenshot({ path: `${out}/02-ctrl-arrow.png` });

step('Prisma panel');
await page.getByRole('button', { name: 'Prisma' }).click();
await page.waitForTimeout(300);
const prisma = await panel('prisma');
step('prisma has model Invoice: ' + prisma.text.includes('model Invoice'));

step('edit Prisma: rename field via editor typing');
// adiciona um campo ao model Invoice digitando no editor
const newPrisma = prisma.text.replace('model Invoice {\n', 'model Invoice {\n  total Decimal @db.Decimal(10, 2)\n');
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.insertText(newPrisma);
await page.waitForTimeout(1200);
const p2 = await panel('prisma');
step('prisma status: ' + p2.status + ' diags: ' + JSON.stringify(p2.diags));
sql = await sqlText();
step('SQL got total numeric(10,2): ' + sql.includes('total numeric(10,2)'));
step('CHECK survived: ' + sql.includes('products_price_positive CHECK (price_cents >= 0)'));
step('partial index survived: ' + sql.includes('WHERE referral_code IS NOT NULL'));
step('canvas shows total: ' + await page.locator('.react-flow__node-table', { hasText: 'invoices' }).locator('text=total').count());

step('syntax error in Prisma does not change model');
await page.locator('.cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.insertText('\nmodel Broken {');
await page.waitForTimeout(1000);
const p3 = await panel('prisma');
step('status: ' + p3.status + ' / ' + p3.diags[0]);
step('tables unchanged: ' + await tables());
await page.screenshot({ path: `${out}/03-prisma-error.png` });
// conserta
await page.keyboard.insertText('\n  id Int @id\n}');
await page.waitForTimeout(1000);
step('after fix status: ' + (await panel('prisma')).status + ' tables: ' + await tables());

step('Drizzle panel reflects');
await page.getByRole('button', { name: 'Drizzle' }).click();
await page.waitForTimeout(300);
const dz = await panel('drizzle');
step('drizzle has broken table + total: ' + dz.text.includes("pgTable('Broken'") + ' ' + dz.text.includes("numeric('total', { precision: 10, scale: 2 })"));

step('Edit drizzle with helper');
const nd = dz.text.replace("export const broken = pgTable('Broken', {", "const ts = { createdAt: timestamp('created_at').defaultNow() };\nexport const broken = pgTable('Broken', {\n  ...ts,");
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.insertText(nd.includes('timestamp,') || nd.includes(' timestamp ') ? nd : nd.replace("import { ", "import { timestamp, "));
await page.waitForTimeout(1500);
const d2 = await panel('drizzle');
step('drizzle status ' + d2.status + ' ' + JSON.stringify(d2.diags));
sql = await sqlText();
step('SQL Broken has created_at: ' + /"Broken"[\s\S]*created_at timestamp DEFAULT now\(\)/.test(sql));

step('Undo (outside editor) x1');
await page.locator('.react-flow__pane').click({ position: { x: 300, y: 800 } });
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
sql = await sqlText();
step('created_at removed after undo: ' + !/"Broken"[\s\S]*created_at/.test(sql));

step('Eraser on Broken table');
await page.keyboard.press('Shift+!');
await page.waitForTimeout(500);
await page.keyboard.press('e');
const broken = page.locator('.react-flow__node-table', { hasText: 'Broken' });
const box = await broken.boundingBox();
await page.mouse.move(box.x + 20, box.y + 15);
await page.mouse.down();
await page.mouse.move(box.x + 60, box.y + 18, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.keyboard.press('v');
step('Broken gone: ' + ((await page.locator('.react-flow__node-table', { hasText: 'Broken' }).count()) === 0));

step('Filters: hide pivot');
await page.keyboard.press('v');
await page.getByRole('button', { name: /Visualização/ }).click();
await page.getByLabel('Tabelas pivot (N:N)').uncheck();
await page.waitForTimeout(400);
step('tables now: ' + await tables() + ' nn edges: ' + await page.locator('.react-flow__edge[data-id^="nn:"]').count());
await page.keyboard.press('Escape');
await page.locator('.react-flow__pane').click({ position: { x: 300, y: 800 } });
await page.screenshot({ path: `${out}/04-filters.png` });
await page.getByRole('button', { name: /Visualização/ }).click();
await page.getByLabel('Tabelas pivot (N:N)').check();
await page.getByRole('button', { name: /Visualização/ }).click();

step('Export PNG of selection');
await page.locator('.react-flow__node-table', { hasText: 'orders_history' }).locator('text=orders_history').first().click();
await page.locator('.react-flow__node-table', { hasText: 'customers' }).locator('text=customers').first().click({ modifiers: ['Shift'] });
await page.getByRole('button', { name: /PNG\/PDF/ }).click();
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar PNG' }).click()]);
await dl.saveAs(`${out}/export.png`);
step('downloaded ' + dl.suggestedFilename());
await page.getByRole('button', { name: /PNG\/PDF/ }).click();
await page.getByRole('button', { name: 'PDF', exact: true }).click();
const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar PDF' }).click()]);
await dl2.saveAs(`${out}/export.pdf`);
step('downloaded ' + dl2.suggestedFilename());

step('Save project zip');
const [dl3] = await Promise.all([page.waitForEvent('download'), page.locator('button[title="Salvar projeto (.zip)"]').click()]);
await dl3.saveAs(`${out}/project.zip`);
step('downloaded ' + dl3.suggestedFilename());

console.log('errors:', errors);
await browser.close();
