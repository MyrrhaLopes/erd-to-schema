import { useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { DocProject, DocReview } from '@erd/docx';
import type { DocxApi } from '../workers/docx.worker';
import { useProjectStore } from '../store/useProjectStore';
import { useEditorContext } from '../store/useEditorContext';
import { saveBlob } from '../persistence/files';

let remote: Comlink.Remote<DocxApi> | null = null;
const worker = () => (remote ??= Comlink.wrap<DocxApi>(new Worker(new URL('../workers/docx.worker.ts', import.meta.url), { type: 'module' })));

export interface DocPreview {
  review: DocReview;
  html: string;
  hash: string;
  fileName: string;
}

/** O que o documento lê do canvas (a projeção do Y.Doc) */
export function currentDocProject(): DocProject {
  const { doc } = useProjectStore.getState();
  return { schema: doc.schema, meta: doc.meta, notes: doc.notes, ...(doc.doc ? { doc: doc.doc } : {}) };
}

/** Nome do projeto como a API usa (o da nuvem; no modo local, o do documento) */
export function docProjectName() {
  const ctx = useEditorContext.getState();
  return ctx.mode === 'remote' && ctx.project ? ctx.project.name : useProjectStore.getState().name;
}

/**
 * Pré-visualização, revisão e hash do documento, recalculados no worker depois de uma
 * pausa nas edições. `null` enquanto o primeiro cálculo não volta.
 */
export function useDocPreview(enabled: boolean, version: number): DocPreview | null {
  const doc = useProjectStore((s) => s.doc);
  const name = useProjectStore((s) => s.name);
  const remoteName = useEditorContext((s) => s.project?.name);
  const [out, setOut] = useState<DocPreview | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const n = ++seq.current;
    const t = setTimeout(
      () =>
        void worker()
          .preview(currentDocProject(), docProjectName(), version)
          .then((r) => n === seq.current && setOut(r))
          .catch((e) => console.error('[docx]', e)),
      out ? 400 : 0,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, doc, name, remoteName, version]);
  return enabled ? out : null;
}

/** Gera o .docx do canvas atual e oferece para salvar */
export async function downloadDocx(version: number) {
  const r = await worker().build(currentDocProject(), docProjectName(), version);
  await saveBlob(new Blob([r.bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), r.fileName, 'Documento do Word');
}
