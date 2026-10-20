import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import { emptyProject } from '@erd/model/project';
import { reconcile } from '@erd/model/reconcile';
import { columnSql } from '@erd/model/formats/sql/generate';
import { applyDiff, codeText, LOCAL_ORIGIN, projectDoc, writeProject, type ProjectDoc } from '@erd/crdt';
import { GENERATORS, readSync, resolveRange } from '../src';
import { client, newBot, parse, replaceIn, syncAll, tableNames, text, typeAt } from './helpers';

const SQL = `CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL,
  total numeric(10,2)
);

ALTER TABLE orders ADD CONSTRAINT orders_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers (id);
`;

async function seeded(): Promise<Y.Doc> {
  const r = await parse('sql', SQL);
  if (!r.ok) throw new Error('parse');
  const rec = reconcile(emptyProject(), r.parsed, 'sql', columnSql);
  const doc = new Y.Doc();
  doc.transact(() => writeProject(doc, { name: 'Loja', schema: rec.schema, layout: {}, meta: rec.meta, notes: [] }));
  return doc;
}

const commit = (doc: Y.Doc, recipe: (d: ProjectDoc) => void) => {
  const before = projectDoc(doc);
  doc.transact(() => applyDiff(doc, before, produce(before, recipe)), LOCAL_ORIGIN);
};

describe('sync bot', () => {
  it('na primeira carga gera os três textos no formato canônico', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    const model = projectDoc(doc);
    expect(text(doc, 'sql')).toBe(GENERATORS.sql(model));
    expect(text(doc, 'prisma')).toContain('model Order {');
    expect(text(doc, 'drizzle')).toContain("pgTable('orders'");
    expect(readSync(doc, 'sql')?.status).toBe('synced');
    bot.stop();
  });

  it('texto → modelo: um CREATE TABLE digitado vira tabela e os outros painéis acompanham', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    typeAt(doc, 'sql', text(doc, 'sql').length, '\nCREATE TABLE products (\n  id serial PRIMARY KEY,\n  name text\n);\n');
    await bot.whenIdle({ flushTimers: true });
    expect(tableNames(doc)).toContain('products');
    expect(text(doc, 'prisma')).toContain('model Product {');
    expect(text(doc, 'drizzle')).toContain("pgTable('products'");
    // o texto de origem não é reformatado
    expect(text(doc, 'sql')).toContain('\nCREATE TABLE products (\n  id serial PRIMARY KEY,\n  name text\n);\n');
    const change = readSync(doc, 'sql')?.change;
    expect(change?.items).toContain('Tabela adicionada: products');
    bot.stop();
  });

  it('sem duplicação: dois clientes digitando no mesmo SQL criam cada tabela uma vez só', async () => {
    const server = await seeded();
    const bot = newBot(server);
    await bot.whenIdle({ flushTimers: true });
    const ana = client('ana', server);
    const bruno = client('bruno', server);
    // Ana escreve no começo, Bruno no fim, ao mesmo tempo
    typeAt(ana, 'sql', 0, 'CREATE TABLE tags (\n  id serial PRIMARY KEY\n);\n\n');
    typeAt(bruno, 'sql', text(bruno, 'sql').length, '\nCREATE TABLE logs (\n  id serial PRIMARY KEY,\n  msg text\n);\n');
    syncAll(ana, bruno, server);
    await bot.whenIdle({ flushTimers: true });
    syncAll(ana, bruno, server);
    const names = tableNames(server);
    expect(names.filter((n) => n === 'tags')).toHaveLength(1);
    expect(names.filter((n) => n === 'logs')).toHaveLength(1);
    for (const d of [ana, bruno]) {
      expect(tableNames(d).sort()).toEqual([...names].sort());
      expect(text(d, 'sql').match(/CREATE TABLE tags/g)).toHaveLength(1);
      expect(text(d, 'prisma').match(/model Tag \{/g)).toHaveLength(1);
    }
    // autoria: a tabela nova é atribuída a quem escreveu
    bot.stop();
  });

  it('parse por bloco: um CREATE TABLE pela metade não apaga a tabela nem bloqueia os outros blocos', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    const before = projectDoc(doc).schema.tables.find((t) => t.name === 'orders')!;
    // Ana quebra o CREATE TABLE orders enquanto Bruno termina uma tabela nova mais abaixo
    replaceIn(doc, 'sql', '  total numeric(10,2)\n);', '  total numeric(10,2),\n  status');
    typeAt(doc, 'sql', text(doc, 'sql').length, '\nCREATE TABLE coupons (\n  id serial PRIMARY KEY,\n  code text\n);\n');
    await bot.whenIdle({ flushTimers: true });
    const model = projectDoc(doc);
    expect(model.schema.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['customers', 'orders', 'coupons']));
    expect(model.schema.tables.find((t) => t.name === 'orders')).toEqual(before);
    expect(model.schema.relationships).toHaveLength(1);
    const st = readSync(doc, 'sql')!;
    expect(st.status).toBe('error');
    expect(st.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    // conserta: agora a coluna entra
    replaceIn(doc, 'sql', '  status', '  status text\n);');
    await bot.whenIdle({ flushTimers: true });
    expect(projectDoc(doc).schema.tables.find((t) => t.name === 'orders')!.columns.map((c) => c.name)).toContain('status');
    expect(readSync(doc, 'sql')!.status).toBe('synced');
    bot.stop();
  });

  it('modelo → texto: renomear no canvas acerta a linha mesmo com o texto formatado à mão, sem perder comentários', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    replaceIn(doc, 'sql', 'CREATE TABLE orders (', '-- pedidos da loja\nCREATE TABLE orders (   -- não mexer\n');
    await bot.whenIdle({ flushTimers: true });
    const ordersId = projectDoc(doc).schema.tables.find((t) => t.name === 'orders')!.id;
    commit(doc, (d) => void (d.schema.tables.find((t) => t.id === ordersId)!.name = 'pedidos'));
    await bot.whenIdle({ flushTimers: true });
    const sql = text(doc, 'sql');
    expect(sql).toContain('-- pedidos da loja\nCREATE TABLE pedidos (   -- não mexer');
    expect(sql).toContain('ALTER TABLE pedidos ADD CONSTRAINT');
    expect(text(doc, 'prisma')).toContain('model Pedido {');
    expect(tableNames(doc)).toContain('pedidos');
    // o bot não entra em loop com as próprias escritas
    let updates = 0;
    doc.on('update', () => updates++);
    await bot.whenIdle({ flushTimers: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(updates).toBe(0);
    bot.stop();
  });

  it('patch que não encaixa vira bloco divergente; o texto antigo não desfaz a mudança do canvas', async () => {
    const server = await seeded();
    const bot = newBot(server);
    await bot.whenIdle({ flushTimers: true });
    const ordersId = projectDoc(server).schema.tables.find((t) => t.name === 'orders')!.id;
    const bruno = client('bruno', server);
    const ana = client('ana', server);
    // Bruno reescreve o bloco de orders (edição ainda não processada) enquanto Ana muda o tipo de total no canvas
    replaceIn(bruno, 'sql', 'CREATE TABLE orders (\n  id serial PRIMARY KEY,\n  customer_id integer NOT NULL,\n  total numeric(10,2)\n);', 'create table orders (id serial primary key, customer_id int not null, total money, obs text);');
    commit(ana, (d) => {
      const t = d.schema.tables.find((t) => t.id === ordersId)!;
      t.columns.find((c) => c.name === 'total')!.type = { base: 'numeric', args: [12, 4] };
    });
    // a digitação do Bruno já chegou ao servidor mas ainda não foi traduzida (debounce)
    // quando a mudança da Ana chega: o patch dela cai justamente no trecho reescrito
    syncAll(bruno, server);
    syncAll(ana, server);
    await bot.whenIdle({ flushTimers: true });
    syncAll(ana, bruno, server);
    const st = readSync(server, 'sql')!;
    expect(st.divergent.length).toBe(1);
    expect(st.divergent[0].ids).toContain(ordersId);
    // o texto do Bruno continua lá, inteiro
    expect(text(server, 'sql')).toContain('create table orders (id serial primary key, customer_id int not null, total money, obs text);');
    // e a mudança da Ana não foi desfeita pelo texto antigo
    const total = projectDoc(server).schema.tables.find((t) => t.id === ordersId)!.columns.find((c) => c.name === 'total')!;
    expect(total.type).toEqual({ base: 'numeric', args: [12, 4] });
    const r = resolveRange(server, st.divergent[0])!;
    expect(text(server, 'sql').slice(r.from, r.to)).toMatch(/^create table orders/);

    // "Usar o diagrama": o bloco é regenerado do modelo
    bot.resolve('sql', st.divergent[0].id, 'diagram');
    await bot.whenIdle({ flushTimers: true });
    expect(readSync(server, 'sql')!.divergent).toEqual([]);
    expect(text(server, 'sql')).toContain('total numeric(12,4)');
    expect(projectDoc(server).schema.tables.find((t) => t.id === ordersId)!.columns.find((c) => c.name === 'total')!.type).toEqual({ base: 'numeric', args: [12, 4] });
    bot.stop();
  });

  it('"Usar o texto": o texto vence no próximo parse', async () => {
    const server = await seeded();
    const bot = newBot(server);
    await bot.whenIdle({ flushTimers: true });
    const ordersId = projectDoc(server).schema.tables.find((t) => t.name === 'orders')!.id;
    const bruno = client('bruno', server);
    replaceIn(bruno, 'sql', 'CREATE TABLE orders (\n  id serial PRIMARY KEY,\n  customer_id integer NOT NULL,\n  total numeric(10,2)\n);', 'create table orders (id serial primary key, customer_id int not null, total money);');
    syncAll(bruno, server);
    commit(server, (d) => void (d.schema.tables.find((t) => t.id === ordersId)!.columns.find((c) => c.name === 'total')!.nullable = false));
    await bot.whenIdle({ flushTimers: true });
    const st = readSync(server, 'sql')!;
    expect(st.divergent.length).toBe(1);
    bot.resolve('sql', st.divergent[0].id, 'text');
    await bot.whenIdle({ flushTimers: true });
    const total = projectDoc(server).schema.tables.find((t) => t.id === ordersId)!.columns.find((c) => c.name === 'total')!;
    expect(total.type.base).toBe('money');
    bot.stop();
  });

  it('ponto fixo: texto canônico → parse → gerar é idempotente nos três formatos', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    const model = projectDoc(doc);
    for (const f of ['sql', 'prisma', 'drizzle'] as const) {
      const t = text(doc, f);
      const r = await parse(f, t);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const rec = reconcile(model, r.parsed, f);
      expect(GENERATORS[f]({ schema: rec.schema, meta: rec.meta })).toBe(t);
    }
    bot.stop();
  });

  it('erro no Drizzle não altera o modelo (arquivo inteiro)', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    const before = projectDoc(doc).schema;
    typeAt(doc, 'drizzle', text(doc, 'drizzle').length, '\nexport const x = pgTable(');
    await bot.whenIdle({ flushTimers: true });
    expect(readSync(doc, 'drizzle')!.status).toBe('error');
    expect(projectDoc(doc).schema).toEqual(before);
    bot.stop();
  });

  it('um .sql importado num documento vazio vira o modelo', async () => {
    const doc = new Y.Doc();
    codeText(doc, 'sql').insert(0, SQL);
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    expect(tableNames(doc)).toEqual(['customers', 'orders']);
    expect(text(doc, 'sql')).toBe(SQL);
    expect(text(doc, 'prisma')).toContain('model Customer {');
    bot.stop();
  });
});

describe('sync bot — Prisma', () => {
  it('um model pela metade fica congelado e um model novo mais abaixo entra', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    const before = projectDoc(doc).schema.tables.find((t) => t.name === 'customers')!;
    replaceIn(doc, 'prisma', 'model Customer {', 'model Customer {\n  nickname Str');
    typeAt(doc, 'prisma', text(doc, 'prisma').length, '\nmodel Coupon {\n  id   Int    @id @default(autoincrement())\n  code String\n\n  @@map("coupons")\n}\n');
    await bot.whenIdle({ flushTimers: true });
    const model = projectDoc(doc);
    expect(model.schema.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['customers', 'orders', 'coupons']));
    expect(model.schema.tables.find((t) => t.name === 'customers')).toEqual(before);
    expect(readSync(doc, 'prisma')!.status).toBe('error');
    expect(text(doc, 'sql')).toContain('CREATE TABLE coupons');
    bot.stop();
  });
});

describe('sync bot — atribuição de erro', () => {
  it('um token solto depois de um statement completo não congela o statement anterior', async () => {
    const doc = await seeded();
    const bot = newBot(doc);
    await bot.whenIdle({ flushTimers: true });
    typeAt(doc, 'sql', text(doc, 'sql').length, '\nCREATE TABLE logs (\n  id serial PRIMARY KEY\n);\n\n)');
    await bot.whenIdle({ flushTimers: true });
    expect(tableNames(doc)).toContain('logs');
    expect(readSync(doc, 'sql')!.status).toBe('error');
    bot.stop();
  });
});
