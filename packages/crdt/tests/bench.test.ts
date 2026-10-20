import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import type { Table } from '@erd/model/types';
import { applyDiff, emptyProjectDoc, LOCAL_ORIGIN, Projector, writeProject, type ProjectDoc } from '../src';

/** Risco do §13: `applyDiff` lento em diagramas grandes */
describe('desempenho com 500 tabelas', () => {
  it('uma edição pequena custa pouco (diff + projeção incremental)', () => {
    const p: ProjectDoc = emptyProjectDoc('grande');
    for (let i = 0; i < 500; i++) {
      const cols = Array.from({ length: 12 }, (_, j) => ({ id: `c_${i}_${j}`, name: `col_${j}`, type: { base: 'text' }, nullable: true }));
      const t: Table = { id: `t_${i}`, name: `tabela_${i}`, columns: cols, primaryKey: [cols[0].id], uniques: [], indexes: [], checks: [] };
      p.schema.tables.push(t);
      p.layout[t.id] = { x: (i % 20) * 300, y: Math.floor(i / 20) * 400 };
    }
    const doc = new Y.Doc();
    doc.transact(() => writeProject(doc, p));
    const proj = new Projector(doc);
    doc.on('afterTransaction', (tr) => proj.update(tr));

    const times: number[] = [];
    for (let k = 0; k < 20; k++) {
      const before = proj.current;
      const after = produce(before, (d) => {
        d.schema.tables[250 + k].columns[3].name = `renomeada_${k}`;
        d.layout[`t_${k}`].x += 10;
      });
      const t0 = performance.now();
      doc.transact(() => applyDiff(doc, before, after, { by: 'u', at: k }), LOCAL_ORIGIN);
      times.push(performance.now() - t0);
      expect(proj.current.schema.tables[250 + k].columns[3].name).toBe(`renomeada_${k}`);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`mediana por edição (diff + projeção): ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(40);
  });
});
