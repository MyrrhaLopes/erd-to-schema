import { strToU8, zipSync } from 'fflate';
import type { NoteBlock } from '@erd/model/types';
import { slugify } from '@erd/model/naming';
import { noteFileNames, noteToMarkdown } from '@erd/model/notes';
import { saveBlob } from './files';

export function downloadNote(n: NoteBlock) {
  void saveBlob(new Blob([noteToMarkdown(n)], { type: 'text/markdown' }), `${slugify(n.title)}.md`, 'Markdown');
}

export function exportNotesZip(notes: NoteBlock[], name = 'notas') {
  const names = noteFileNames(notes);
  const files: Record<string, Uint8Array> = {};
  for (const n of notes) files[names.get(n.id)!] = strToU8(noteToMarkdown(n));
  const zip = zipSync(files, { level: 6 });
  void saveBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${slugify(name)}-notas.zip`, 'Zip');
}
