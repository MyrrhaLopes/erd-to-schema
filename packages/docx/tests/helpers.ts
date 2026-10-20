import { readFileSync } from 'node:fs';
import { parse as pgParse } from 'libpg-query';
import { parseSql } from '@erd/model/formats/sql/parse';
import { columnSql } from '@erd/model/formats/sql/generate';
import { reconcile } from '@erd/model/reconcile';
import { emptyProject } from '@erd/model/project';
import { emptyDocContent } from '@erd/model/docContent';
import type { DocContent, Project } from '@erd/model/types';

export async function fromSql(sql: string, name = 'Teste'): Promise<Project> {
  const r = await parseSql(sql, pgParse as never);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('\n'));
  const p = emptyProject(name);
  const rec = reconcile(p, r.parsed, 'sql', columnSql);
  return { ...p, schema: rec.schema, meta: rec.meta };
}

interface CessForm {
  project: string;
  cover: DocContent['cover'];
  intro: string;
  conventions: Record<string, string>;
  rules: Record<string, string[]>;
  functions: Record<string, { fromSide?: string; toSide?: string }>;
  notes: { title: string; content: string }[];
}

/** O projeto da fixture CESS (cess.sql + cess.doc.json), com o formulário preso aos IDs gerados */
export async function cessProject(): Promise<Project> {
  const dir = new URL('./fixtures/', import.meta.url);
  const form = JSON.parse(readFileSync(new URL('cess.doc.json', dir), 'utf8')) as CessForm;
  const p = await fromSql(readFileSync(new URL('cess.sql', dir), 'utf8'), form.project);
  const byName = (n: string) => p.schema.tables.find((t) => t.name === n)!;
  const doc = emptyDocContent();
  doc.cover = form.cover;
  doc.intro = form.intro;
  for (const [k, goal] of Object.entries(form.conventions)) doc.conventions.detected[k] = { goal };
  for (const [t, rules] of Object.entries(form.rules)) doc.tables[byName(t).id] = { rules };
  for (const [ref, fn] of Object.entries(form.functions)) {
    const [tn, cn] = ref.split('.');
    const t = byName(tn);
    const col = t.columns.find((c) => c.name === cn)!;
    const rel = p.schema.relationships.find((r) => r.kind === 'fk' && r.fromTable === t.id && r.fromColumns.includes(col.id))!;
    doc.relationships[rel.id] = fn;
  }
  p.notes = form.notes.map((n, i) => ({ id: `n${i}`, ...n }));
  p.doc = doc;
  return p;
}
