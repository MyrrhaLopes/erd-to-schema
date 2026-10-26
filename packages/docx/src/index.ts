import { buildOutline, MAIN_TITLE_FALLBACK, type DocMeta, type DocProject, type DocReview, type Outline } from './outline';
import { pack } from './render';

export * from './outline';
export { computeModules, isModuleTag, splitModuleTag, markdownToBlocks, MODULE_RE } from './modules';
export { detectConventions, typeLabel, defaultLabel, uniqueLabel, relationshipRows, fieldRows } from './derive';
export { outlineToHtml } from './html';
export { diffProjects, type ProjectDiff } from './diff';

export interface DataDictionary {
  bytes: Uint8Array;
  outline: Outline;
  review: DocReview;
}

/** Gera o .docx (função pura e determinística: as datas vêm de `meta.publishedAt`) */
export async function buildDataDictionary(project: DocProject, meta: DocMeta): Promise<DataDictionary> {
  const { outline, review } = buildOutline(project, meta);
  const title = project.doc?.cover.title.trim() || MAIN_TITLE_FALLBACK;
  const bytes = await pack(outline, { title, creator: 'EasiER', publishedAt: meta.publishedAt });
  return { bytes, outline, review };
}

/**
 * Hash do conteúdo do documento: o outline sem número de versão nem data. Igual ao da última
 * publicação = "nada mudou"; é também o que a tela de revisão confirma (§3.1).
 */
export async function contentHash(project: DocProject, projectName: string): Promise<string> {
  const { outline } = buildOutline(project, { projectName, version: 0, publishedAt: new Date(0) });
  const data = new TextEncoder().encode(JSON.stringify(outline));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
