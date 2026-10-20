import type { Project } from '@erd/model/types';
import { slugify } from '@erd/model/naming';
import { buildProjectZip, readImport, type ImportResult } from '@erd/model/projectFile';
import { saveBlob } from './files';

export type { ImportResult };

export async function exportProjectZip(p: Project) {
  const zip = buildProjectZip(p);
  return saveBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${slugify(p.name)}.erd.zip`, 'Projeto ERD');
}

export async function exportProjectJson(p: Project) {
  return saveBlob(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${slugify(p.name)}.erd.json`, 'Projeto ERD');
}

export function readImportFile(file: File): Promise<ImportResult> {
  return readImport(file.name, async () => new Uint8Array(await file.arrayBuffer()), () => file.text());
}
