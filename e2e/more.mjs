import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const executablePath = process.env.CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const out = process.env.OUT ?? '.';
const browser = await chromium.launch({ executablePath });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (s) => console.log('▶', s);
const sqlText = () => page.evaluate(async () => (await import('/src/sync/engine.ts')).usePanels.getState().panels.sql.text);
const node = (name) => page.locator('.react-flow__node-table').filter({ has: page.locator(`span:text-is("${name}")`) });

await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForSelector('.react-flow__node-table');
await page.waitForTimeout(800);

step('relation tool click-click N:N between customers and products');
await page.keyboard.press('a');
await page.getByRole('button', { name: 'N:N', exact: true }).click();
await node('customers').locator('span:text-is("customers")').click();
await node('products').locator('span:text-is("products")').click();
await page.waitForTimeout(400);
let sql = await sqlText();
step('pivot created: ' + /CREATE TABLE customer_products \(\n  customer_id integer,\n  product_id integer,\n  PRIMARY KEY \(customer_id, product_id\)/.test(sql));
await page.getByRole('button', { name: 'FK', exact: true }).click();

step('drag handle: orders.referral_code → customers.email (FK)');
const src = node('orders').locator('div', { hasText: /^referral_code/ }).locator('.react-flow__handle-right').first();
const dst = node('customers').locator('div', { hasText: /^email/ }).locator('.react-flow__handle-left').first();
await page.keyboard.press('Escape'); // fecha o inspector, que pode cobrir o handle
await page.waitForTimeout(200);
const a = await src.boundingBox();
const b = await dst.boundingBox();
await page.mouse.move(a.x + 3, a.y + 3);
await page.mouse.down();
await page.mouse.move(a.x + 40, a.y + 3, { steps: 5 });
await page.mouse.move(b.x + 3, b.y + 3, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
sql = await sqlText();
step('FK referral_code → email: ' + /FOREIGN KEY \(referral_code\) REFERENCES customers \(email\)/.test(sql));

step('note edit (double click)');
const note = page.locator('.react-flow__node-note').first();
await note.dblclick();
await page.waitForTimeout(200);
await page.keyboard.press('Control+a');
await page.keyboard.type('# Título\n\n- item **forte**');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(200);
step('note rendered h1: ' + await note.locator('h1').count() + ' strong: ' + await note.locator('strong').count());

step('create table with R tool');
await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
await page.keyboard.press('r');
await page.locator('.react-flow__pane').click({ position: { x: 150, y: 820 } });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
sql = await sqlText();
step('has nova_tabela: ' + sql.includes('CREATE TABLE nova_tabela'));

step('reload page → persisted');
await page.waitForTimeout(800);
await page.reload();
await page.waitForSelector('.react-flow__node-table');
await page.waitForTimeout(800);
sql = await sqlText();
step('persisted pivot+nova_tabela: ' + sql.includes('customer_products') + ' ' + sql.includes('nova_tabela'));
step('persisted note: ' + await page.locator('.react-flow__node-note h1').count());
await page.screenshot({ path: `${out}/07-reloaded.png` });
console.log('errors:', errors);
await browser.close();
