import type { NoteBlock } from './types';
import { slugify } from './naming';

/** Nota → arquivo .md com front matter (id/título/cor) para reimportar sem perder a identidade */
export function noteToMarkdown(n: NoteBlock): string {
  const fm = [`id: ${n.id}`, `title: ${JSON.stringify(n.title)}`];
  if (n.color) fm.push(`color: ${n.color}`);
  return `---\n${fm.join('\n')}\n---\n\n${n.content.replace(/\s+$/, '')}\n`;
}

export function parseNoteMarkdown(text: string, fallbackTitle: string): Partial<NoteBlock> & { content: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    const h = text.match(/^#\s+(.+)$/m);
    return { title: h?.[1]?.trim() ?? fallbackTitle, content: text.trim() };
  }
  const out: Partial<NoteBlock> & { content: string } = { content: text.slice(m[0].length).replace(/^\s*\n/, '').replace(/\s+$/, '') };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, raw] = kv;
    let v = raw.trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        /* mantém cru */
      }
    }
    if (k === 'id') out.id = v;
    if (k === 'title') out.title = v;
    if (k === 'color') out.color = v;
  }
  if (!out.title) out.title = fallbackTitle;
  return out;
}

/** Nomes de arquivo únicos e estáveis para as notas */
export function noteFileNames(notes: NoteBlock[]): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const n of notes) {
    const base = slugify(n.title);
    let name = `${base}.md`;
    let i = 2;
    while (taken.has(name)) name = `${base}-${i++}.md`;
    taken.add(name);
    out.set(n.id, name);
  }
  return out;
}
