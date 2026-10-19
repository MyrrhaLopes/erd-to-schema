import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { produce } from 'immer';
import { createTestDatabase } from '@erd/db/testing';
import { canvases, canvasUpdates, eq, projects, users } from '@erd/db';
import { applyDiff, emptyProjectDoc, fromProject, LOCAL_ORIGIN, projectDoc } from '@erd/crdt';
import { CanvasStore } from '../src';

let t: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.insert(users).values({ id: 'u1', name: 'Ana', email: 'ana@x.com' });
  await t.db.insert(projects).values({ id: 'p1', name: 'Loja', ownerId: 'u1' });
  await t.db.insert(canvases).values({ id: 'c1', projectId: 'p1', kind: 'erd', name: 'Diagrama ER' });
});
afterAll(() => t?.drop());

describe('CanvasStore', () => {
  it('log + compactação preservam o estado', async () => {
    const store = new CanvasStore(t.db, { maxUpdates: 3, maxAgeMs: 60_000 });
    const p = emptyProjectDoc('Loja');
    p.notes.push({ id: 'n1', title: 'Nota', content: 'oi' });
    await store.initialize('c1', fromProject(p));

    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await store.load('c1'))!);
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    for (let i = 0; i < 4; i++) {
      const before = projectDoc(doc);
      doc.transact(() => applyDiff(doc, before, produce(before, (d) => void (d.notes[0].content += `-${i}`))), LOCAL_ORIGIN);
    }
    for (const u of updates) await store.append('c1', u);
    expect(await store.shouldCompact('c1')).toBe(true);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, (await store.load('c1'))!);
    expect(projectDoc(fresh).notes[0].content).toBe('oi-0-1-2-3');

    await store.compact('c1');
    expect(await t.db.select().from(canvasUpdates).where(eq(canvasUpdates.canvasId, 'c1'))).toHaveLength(0);
    const again = new Y.Doc();
    Y.applyUpdate(again, (await store.load('c1'))!);
    expect(projectDoc(again).notes[0].content).toBe('oi-0-1-2-3');
    expect(((await store.snapshot('c1')) as { notes: { content: string }[] }).notes[0].content).toBe('oi-0-1-2-3');
    expect(await store.shouldCompact('c1')).toBe(false);
  });
});
