import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { emptyProject } from '@erd/model/project';
import { reconcile } from '@erd/model/reconcile';
import { columnSql } from '@erd/model/formats/sql/generate';
import { codeText, projectDoc, writeProject } from '@erd/crdt';
import { readSync } from '../src';
import { client, newBot, parse, syncAll, tableNames, text } from './helpers';

const SQL = `CREATE TABLE a (\n  id serial PRIMARY KEY\n);\n\nCREATE TABLE b (\n  id serial PRIMARY KEY,\n  a_id integer\n);\n`;

describe('propriedade: sem duplicação', () => {
  it('N clientes digitando tabelas novas em pontos aleatórios do mesmo texto → cada tabela uma vez', async () => {
    const r = await parse('sql', SQL);
    if (!r.ok) throw new Error('parse');
    const rec = reconcile(emptyProject(), r.parsed, 'sql', columnSql);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ client: fc.nat(2), boundary: fc.nat(10), chunks: fc.integer({ min: 1, max: 3 }) }), { minLength: 1, maxLength: 6 }),
        async (edits) => {
          const server = new Y.Doc();
          server.transact(() => writeProject(server, { name: 'p', schema: rec.schema, layout: {}, meta: rec.meta, notes: [] }));
          const bot = newBot(server);
          await bot.whenIdle({ flushTimers: true });
          const clients = [client('u0', server), client('u1', server), client('u2', server)];
          const expected: string[] = [];
          for (const [i, e] of edits.entries()) {
            const doc = clients[e.client];
            const t = codeText(doc, 'sql');
            const s = t.toString();
            // insere num limite entre statements (logo depois de um `;\n`, ou no começo)
            const bounds = [0, ...[...s.matchAll(/;\n/g)].map((m) => m.index! + 2)];
            const at = bounds[e.boundary % bounds.length];
            const name = `t${i}`;
            expected.push(name);
            const stmt = `\nCREATE TABLE ${name} (\n  id serial PRIMARY KEY\n);\n`;
            // digitação em pedaços: o bot pode ver o statement pela metade
            const size = Math.ceil(stmt.length / e.chunks);
            // o cursor é relativo, como no editor: o que chega de outros clientes não o desloca
            let cursor = Y.createRelativePositionFromTypeIndex(t, at);
            for (let k = 0; k < stmt.length; k += size) {
              const pos = Y.createAbsolutePositionFromRelativePosition(cursor, doc)!.index;
              t.insert(pos, stmt.slice(k, k + size));
              cursor = Y.createRelativePositionFromTypeIndex(t, pos + Math.min(size, stmt.length - k), -1);
              if (i % 2) syncAll(doc, server);
              await bot.whenIdle({ flushTimers: k % 2 === 0 });
            }
          }
          syncAll(server, ...clients);
          await bot.whenIdle({ flushTimers: true });
          syncAll(server, ...clients);
          await bot.whenIdle({ flushTimers: true });
          syncAll(server, ...clients);
          const names = tableNames(server);
          for (const n of expected) expect(names.filter((x) => x === n)).toHaveLength(1);
          expect(readSync(server, 'sql')!.status).toBe('synced');
          for (const c of clients) {
            for (const n of expected) {
              expect(text(c, 'sql').split(`CREATE TABLE ${n} (`).length - 1).toBe(1);
              expect(text(c, 'drizzle').split(`pgTable('${n}'`).length - 1).toBe(1);
            }
            expect(projectDoc(c).schema.tables.length).toBe(names.length);
          }
          bot.stop();
        },
      ),
      { numRuns: 25 },
    );
  }, 60_000);
});
