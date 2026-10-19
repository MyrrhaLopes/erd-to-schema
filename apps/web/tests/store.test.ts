import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { projectDoc } from '@erd/crdt';
import { redo, undo, useProjectStore } from '../src/store/useProjectStore';
import { addColumn, createTable, deleteElements, moveNodes, updateTable } from '../src/store/actions';
import { memorySession } from './session';

const state = () => useProjectStore.getState();

describe('store sobre o Y.Doc', () => {
  it('commit escreve no documento e a projeção volta para o store', () => {
    const s = memorySession();
    const id = createTable({ x: 10, y: 20 });
    expect(state().doc.schema.tables.map((t) => t.id)).toEqual([id]);
    expect(projectDoc(s.doc).schema.tables[0].name).toBe('nova_tabela');
    expect(state().lastOrigin).toBe('canvas');
  });

  it('undo/redo desfazem só as mudanças locais, uma entrada por ação', () => {
    const s = memorySession();
    const id = createTable({ x: 0, y: 0 });
    addColumn(id);
    updateTable(id, (t) => void (t.name = 'clientes'));
    expect(state().canUndo).toBe(true);
    undo();
    expect(state().doc.schema.tables[0].name).toBe('nova_tabela');
    expect(state().lastOrigin).toBe('history');
    undo();
    expect(state().doc.schema.tables[0].columns).toHaveLength(1);
    redo();
    expect(state().doc.schema.tables[0].columns).toHaveLength(2);

    // uma mudança remota (outro cliente) não entra no meu undo
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(s.doc));
    (other.getMap('tables').get(id) as Y.Map<unknown>).set('comment', 'do colega');
    Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(s.doc)));
    expect(state().doc.schema.tables[0].comment).toBe('do colega');
    expect(state().lastOrigin).toBe('remote');
    undo();
    expect(state().doc.schema.tables[0].comment).toBe('do colega');
  });

  it('mover nós grava uma posição só e as tabelas intocadas mantêm a referência', () => {
    memorySession();
    const a = createTable({ x: 0, y: 0 });
    const b = createTable({ x: 400, y: 0 });
    const ta = state().doc.schema.tables.find((t) => t.id === a);
    moveNodes([{ id: b, x: 500, y: 50 }]);
    expect(state().doc.layout[b]).toEqual({ x: 500, y: 50 });
    expect(state().doc.schema.tables.find((t) => t.id === a)).toBe(ta);
    deleteElements({ nodes: [a, b], edges: [] });
    expect(state().doc.schema.tables).toEqual([]);
    undo();
    expect(state().doc.schema.tables.map((t) => t.id).sort()).toEqual([a, b].sort());
  });
});
