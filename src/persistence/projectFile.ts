import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Format, NoteBlock, Project } from '../model/types';
import { newId, slugify } from '../model/naming';
import { defaultView } from '../model/project';
import { generateSql } from '../formats/sql/generate';
import { generatePrisma } from '../formats/prisma/generate';
import { generateDrizzle } from '../formats/drizzle/generate';
import { noteFileNames, noteToMarkdown, parseNoteMarkdown } from './notes';
import { saveBlob } from './files';

interface ProjectJson extends Omit<Project, 'notes'> {
  notes: (Omit<NoteBlock, 'content'> & { file: string; content?: string })[];
}

/** `.zip`: project.json (modelo+layout) + notes/*.md + cópias de schema.sql/.prisma/.ts */
export function buildProjectZip(p: Project): Uint8Array {
  const names = noteFileNames(p.notes);
  const json: ProjectJson = {
    ...p,
    notes: p.notes.map(({ content: _c, ...n }) => ({ ...n, file: `notes/${names.get(n.id)}` })),
  };
  const files: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify(json, null, 2)),
    'schema.sql': strToU8(generateSql(p)),
    'schema.prisma': strToU8(generatePrisma(p)),
    'schema.ts': strToU8(generateDrizzle(p)),
  };
  for (const n of p.notes) files[`notes/${names.get(n.id)}`] = strToU8(noteToMarkdown(n));
  return zipSync(files, { level: 6 });
}

export async function exportProjectZip(p: Project) {
  const zip = buildProjectZip(p);
  return saveBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${slugify(p.name)}.erd.zip`, 'Projeto ERD');
}

export async function exportProjectJson(p: Project) {
  return saveBlob(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${slugify(p.name)}.erd.json`, 'Projeto ERD');
}

export type ImportResult =
  | { kind: 'project'; project: Project }
  | { kind: 'schema'; format: Format; text: string }
  | { kind: 'notes'; notes: NoteBlock[] };

function normalizeProject(raw: Partial<Project>): Project {
  if (!raw || typeof raw !== 'object' || !raw.schema) throw new Error('Arquivo de projeto inválido');
  return {
    version: 1,
    name: raw.name ?? 'Projeto importado',
    schema: { tables: raw.schema.tables ?? [], enums: raw.schema.enums ?? [], relationships: raw.schema.relationships ?? [] },
    layout: raw.layout ?? {},
    meta: raw.meta ?? {},
    notes: raw.notes ?? [],
    view: { ...defaultView(), ...(raw.view ?? {}) },
  };
}

/** Lê um zip de projeto: as notas .md são a fonte da verdade do conteúdo */
export function readProjectZip(data: Uint8Array): ImportResult {
  const files = unzipSync(data);
  const mdFiles = Object.keys(files).filter((k) => k.endsWith('.md'));
  if (!files['project.json']) {
    const notes = mdFiles.map((f) => {
      const parsed = parseNoteMarkdown(strFromU8(files[f]), f.replace(/^.*\//, '').replace(/\.md$/, ''));
      return { id: newId('n_'), title: parsed.title ?? 'Nota', content: parsed.content, color: parsed.color };
    });
    if (!notes.length) throw new Error('Zip sem project.json nem notas .md');
    return { kind: 'notes', notes };
  }
  const json = JSON.parse(strFromU8(files['project.json'])) as ProjectJson;
  const used = new Set<string>();
  const notes: NoteBlock[] = (json.notes ?? []).map((n) => {
    const { file, ...rest } = n;
    const raw = file && files[file] ? parseNoteMarkdown(strFromU8(files[file]), n.title) : null;
    if (file) used.add(file);
    return { ...rest, title: raw?.title ?? n.title, color: raw?.color ?? n.color, content: raw?.content ?? n.content ?? '' };
  });
  // .md novos colocados na pasta notes/ viram notas novas
  const project = normalizeProject({ ...json, notes });
  let y = 0;
  for (const f of mdFiles) {
    if (used.has(f)) continue;
    const parsed = parseNoteMarkdown(strFromU8(files[f]), f.replace(/^.*\//, '').replace(/\.md$/, ''));
    const existing = parsed.id ? project.notes.find((n) => n.id === parsed.id) : undefined;
    if (existing) {
      existing.content = parsed.content;
      continue;
    }
    const id = newId('n_');
    project.notes.push({ id, title: parsed.title ?? 'Nota', content: parsed.content, color: parsed.color });
    project.layout[id] = { x: -320, y, w: 260, h: 180 };
    y += 200;
  }
  return { kind: 'project', project };
}

export async function readImportFile(file: File): Promise<ImportResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip')) return readProjectZip(new Uint8Array(await file.arrayBuffer()));
  const text = await file.text();
  if (name.endsWith('.json')) return { kind: 'project', project: normalizeProject(JSON.parse(text)) };
  if (name.endsWith('.sql')) return { kind: 'schema', format: 'sql', text };
  if (name.endsWith('.prisma')) return { kind: 'schema', format: 'prisma', text };
  if (name.endsWith('.ts') || name.endsWith('.js')) return { kind: 'schema', format: 'drizzle', text };
  if (name.endsWith('.md')) {
    const p = parseNoteMarkdown(text, file.name.replace(/\.md$/i, ''));
    return { kind: 'notes', notes: [{ id: newId('n_'), title: p.title ?? 'Nota', content: p.content, color: p.color }] };
  }
  throw new Error('Formato não reconhecido: ' + file.name);
}
