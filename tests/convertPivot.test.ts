import { describe, expect, it } from 'vitest';
import { useProjectStore } from '../src/store/useProjectStore';
import { createTable, convertNoteToPivot } from '../src/store/actions';
import { newId } from '../src/model/naming';

describe('convertNoteToPivot', () => {
  it('converts a bidirectional N:N note relation into a real pivot table', () => {
    const t1Id = createTable({ x: 0, y: 0 });
    const t2Id = createTable({ x: 300, y: 0 });

    const relId = newId('r_');
    useProjectStore.getState().commit((d) => {
      d.schema.relationships.push({
        id: relId,
        kind: 'note',
        fromTable: t1Id,
        fromColumns: [],
        toTable: t2Id,
        toColumns: [],
        label: 'autores',
        cardinality: 'N:N',
        showReverse: true,
        reverseCardinality: 'N:N',
        reverseLabel: 'livros',
      });
    }, 'canvas', ['Adiciona relação note N:N']);

    const stateBefore = useProjectStore.getState().doc;
    expect(stateBefore.schema.relationships.some((r) => r.id === relId)).toBe(true);

    // Converte a relação em tabela pivot
    convertNoteToPivot(relId);

    const stateAfter = useProjectStore.getState().doc;
    // Relação-nota original foi removida
    expect(stateAfter.schema.relationships.some((r) => r.id === relId)).toBe(false);

    // Tabela pivot foi criada
    const pivotTable = stateAfter.schema.tables.find(
      (t) => stateAfter.meta[t.id]?.provenance?.kind === 'pivot',
    );
    expect(pivotTable).toBeDefined();
    expect(pivotTable?.primaryKey.length).toBe(2);

    // Existem duas FKs apontando para t1 e t2 a partir da pivot table com onDelete: 'cascade'
    const pivotFks = stateAfter.schema.relationships.filter(
      (r) => r.kind === 'fk' && r.fromTable === pivotTable?.id,
    );
    expect(pivotFks).toHaveLength(2);
    expect(pivotFks.map((r) => r.toTable).sort()).toEqual([t1Id, t2Id].sort());
    expect(pivotFks[0].onDelete).toBe('cascade');
    expect(pivotFks[1].onDelete).toBe('cascade');
  });
});
