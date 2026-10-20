import type { Project, Table } from '@erd/model/types';
import { formatType } from '@erd/model/columnType';

export interface ProjectDiff {
  tablesAdded: string[];
  tablesRemoved: string[];
  tablesChanged: string[];
  columnsAdded: string[];
  columnsRemoved: string[];
  columnsChanged: string[];
}

const colSig = (c: Table['columns'][number]) => JSON.stringify([formatType(c.type), c.nullable, c.default ?? null, !!c.unique, c.identity ?? null, c.comment ?? null]);

/** O que mudou desde a última publicação (tela de revisão): por ID, com os nomes atuais */
export function diffProjects(before: Pick<Project, 'schema'> | null, after: Pick<Project, 'schema'>): ProjectDiff {
  const d: ProjectDiff = { tablesAdded: [], tablesRemoved: [], tablesChanged: [], columnsAdded: [], columnsRemoved: [], columnsChanged: [] };
  const prev = new Map((before?.schema.tables ?? []).map((t) => [t.id, t]));
  const next = new Map(after.schema.tables.map((t) => [t.id, t]));
  for (const [id, t] of prev) if (!next.has(id)) d.tablesRemoved.push(t.name);
  for (const [id, t] of next) {
    const p = prev.get(id);
    if (!p) {
      if (before) d.tablesAdded.push(t.name);
      continue;
    }
    let changed =
      p.name !== t.name ||
      (p.comment ?? '') !== (t.comment ?? '') ||
      JSON.stringify([p.primaryKey, p.uniques, p.indexes, p.checks]) !== JSON.stringify([t.primaryKey, t.uniques, t.indexes, t.checks]);
    const pc = new Map(p.columns.map((c) => [c.id, c]));
    const nc = new Map(t.columns.map((c) => [c.id, c]));
    for (const [cid, c] of pc) {
      if (nc.has(cid)) continue;
      d.columnsRemoved.push(`${t.name}.${c.name}`);
      changed = true;
    }
    for (const [cid, c] of nc) {
      const o = pc.get(cid);
      if (!o) {
        d.columnsAdded.push(`${t.name}.${c.name}`);
        changed = true;
      } else if (o.name !== c.name || colSig(o) !== colSig(c)) {
        d.columnsChanged.push(o.name !== c.name ? `${t.name}.${o.name} → ${c.name}` : `${t.name}.${c.name}`);
        changed = true;
      }
    }
    if (changed) d.tablesChanged.push(p.name !== t.name ? `${p.name} → ${t.name}` : t.name);
  }
  return d;
}
