/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { buildDataDictionary, buildOutline, contentHash, outlineToHtml, type DocProject } from '@erd/docx';

/**
 * Gerador do dicionário de dados no navegador (drive-docx-plan §1.5): a pré-visualização,
 * o hash do conteúdo (o mesmo que a API calcula) e o "Baixar .docx", fora da thread da UI.
 */
const api = {
  async preview(project: DocProject, projectName: string, version: number) {
    const { outline, review } = buildOutline(project, { projectName, version, publishedAt: new Date() });
    return { review, html: outlineToHtml(outline), hash: await contentHash(project, projectName), fileName: outline.fileName };
  },
  async build(project: DocProject, projectName: string, version: number) {
    const { bytes, review } = await buildDataDictionary(project, { projectName, version, publishedAt: new Date() });
    return Comlink.transfer({ bytes, fileName: review.fileName }, [bytes.buffer as ArrayBuffer]);
  },
};

export type DocxApi = typeof api;
Comlink.expose(api);
