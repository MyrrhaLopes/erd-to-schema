import { afterAll, describe, expect, it } from 'vitest';
import { createDrizzleSandbox, type DrizzleSandbox } from '../src';

const SCHEMA = `import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: serial().primaryKey(), name: text().notNull() });
export const posts = pgTable('posts', { id: serial().primaryKey(), userId: integer('user_id').references(() => users.id) });
`;

const pools: DrizzleSandbox[] = [];
afterAll(async () => {
  for (const p of pools) await p.close();
});

for (const kind of ['isolate', 'process'] as const) {
  describe(`sandbox do Drizzle (${kind})`, () => {
    const sb = createDrizzleSandbox({ force: kind, size: 1, timeoutMs: 800, memoryMb: 48 });
    pools.push(sb);

    it('executa um schema válido', async () => {
      const r = await sb.parse(SCHEMA);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.parsed.schema.tables.map((t) => t.name)).toEqual(['users', 'posts']);
        expect(r.parsed.schema.relationships).toHaveLength(1);
        // IDs novos e distintos a cada parse
        const again = await sb.parse(SCHEMA);
        if (again.ok) expect(again.parsed.schema.tables[0].id).not.toBe(r.parsed.schema.tables[0].id);
      }
    });

    it('loop infinito → timeout, e o sandbox continua funcionando', async () => {
      const t0 = Date.now();
      const r = await sb.parse('while (true) {}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.diagnostics[0].message).toMatch(/Tempo esgotado/);
      expect(Date.now() - t0).toBeLessThan(4000);
      expect((await sb.parse(SCHEMA)).ok).toBe(true);
    });

    it('require("fs"), process e fetch não existem', async () => {
      for (const [src, msg] of [
        ["const fs = require('fs'); export const x = fs.readFileSync('/etc/passwd', 'utf8');", /não é permitido/],
        ["const cp = require('child_process');", /não é permitido/],
        ['export const x = process.env.DATABASE_URL;', /process is not defined/],
        ["export const x = fetch('http://example.com');", /fetch is not defined/],
      ] as const) {
        const r = await sb.parse(src);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.diagnostics[0].message).toMatch(msg);
      }
    });

    it('escapar do contexto não dá acesso a segredos', async () => {
      process.env.DATABASE_URL ??= 'postgres://segredo';
      const r = await sb.parse("const p = globalThis.constructor.constructor('return process')(); if (p.env.DATABASE_URL) throw new Error('VAZOU'); throw new Error('sem segredos');");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.diagnostics[0].message).toMatch(kind === 'isolate' ? /process is not defined/ : /sem segredos/);
    });

    if (kind === 'isolate')
      it('alocação gigante → limite de memória, sem derrubar o processo', async () => {
        const r = await sb.parse('const a = []; while (true) a.push(new Array(1e6).fill(1));');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.diagnostics[0].message).toMatch(/memória|Tempo esgotado/);
        expect((await sb.parse(SCHEMA)).ok).toBe(true);
      });

    it('o erro aponta a linha certa', async () => {
      const r = await sb.parse('const a = 1;\nconst b = 2;\nnull.x;');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.diagnostics[0].from).toBe(26);
    });
  });
}
