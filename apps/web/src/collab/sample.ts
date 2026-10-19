import type { Project } from '@erd/model/types';
import { emptyProject, NOTE_H, NOTE_W } from '@erd/model/project';
import { newId } from '@erd/model/naming';
import { reconcile } from '@erd/model/reconcile';
import { columnSql } from '@erd/model/formats/sql/generate';
import { parseInWorker } from '../sync/parserClient';
import { SAMPLE_NOTES, SAMPLE_SQL } from '../sample';

export async function buildSampleProject(): Promise<Project> {
  const p = emptyProject('Exemplo — loja');
  const r = await parseInWorker('sql', SAMPLE_SQL);
  if (r.ok) {
    const rec = reconcile(p, r.parsed, 'sql', columnSql);
    p.schema = rec.schema;
    p.meta = rec.meta;
  }
  for (const n of SAMPLE_NOTES) {
    const id = newId('n_');
    p.notes.push({ id, ...n });
    p.layout[id] = { x: -340, y: 0, w: NOTE_W + 20, h: NOTE_H + 70 };
  }
  return p;
}
