import { getNodesBounds, type Edge, type Node } from '@xyflow/react';
import { saveBlob } from '../persistence/files';

export interface ExportOptions {
  nodes: Node[];
  edges: Edge[];
  onlySelected: boolean;
  format: 'png' | 'pdf';
  pixelRatio: number;
  background: 'white' | 'transparent';
  pdfPage: 'image' | 'a4-landscape' | 'a4-portrait';
  fileName: string;
}

const PADDING = 40;

/** Renderiza a seleção (ou tudo) via html-to-image sobre `.react-flow__viewport` */
export async function renderPng(opts: ExportOptions): Promise<{ dataUrl: string; width: number; height: number }> {
  // pontos de presença (minimapa) não são do diagrama
  const nodes = opts.nodes.filter((n) => n.type !== 'peer');
  const target = opts.onlySelected && nodes.some((n) => n.selected) ? nodes.filter((n) => n.selected) : nodes;
  if (!target.length) throw new Error('Nada para exportar');
  const ids = new Set(target.map((n) => n.id));
  const keepEdge = new Set(opts.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => e.id));
  const bounds = getNodesBounds(target);
  const width = Math.ceil(bounds.width + PADDING * 2);
  const height = Math.ceil(bounds.height + PADDING * 2);

  const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  if (!viewport) throw new Error('Canvas não encontrado');

  // os <marker> do pé-de-galinha vivem fora do viewport; copiamos para dentro durante a captura
  const defs = document.querySelector('#erd-marker-defs');
  let injected: Element | null = null;
  if (defs) {
    injected = defs.cloneNode(true) as Element;
    injected.removeAttribute('id');
    viewport.prepend(injected);
  }
  viewport.classList.add('erd-exporting');
  try {
    const { toPng } = await import('html-to-image');
    const dataUrl = await toPng(viewport, {
      width,
      height,
      pixelRatio: opts.pixelRatio,
      backgroundColor: opts.background === 'white' ? '#ffffff' : undefined,
      skipFonts: true,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${PADDING - bounds.x}px, ${PADDING - bounds.y}px) scale(1)`,
      },
      filter: (el: HTMLElement) => {
        if (!(el instanceof Element)) return true;
        const cl = el.classList;
        if (cl.contains('react-flow__node')) return ids.has(el.getAttribute('data-id') ?? '');
        if (cl.contains('react-flow__edge')) return keepEdge.has(el.getAttribute('data-id') ?? '');
        const edgeLabel = el.getAttribute('data-edge-id');
        if (edgeLabel) return keepEdge.has(edgeLabel);
        if (cl.contains('erd-export-hide')) return false;
        if (cl.contains('react-flow__handle') || cl.contains('react-flow__resize-control') || cl.contains('react-flow__nodesselection')) return false;
        return true;
      },
    });
    return { dataUrl, width, height };
  } finally {
    injected?.remove();
    viewport.classList.remove('erd-exporting');
  }
}

async function dataUrlToBlob(url: string) {
  return (await fetch(url)).blob();
}

export async function exportImage(opts: ExportOptions) {
  const { dataUrl, width, height } = await renderPng(opts);
  if (opts.format === 'png') {
    await saveBlob(await dataUrlToBlob(dataUrl), `${opts.fileName}.png`, 'PNG');
    return;
  }
  const { jsPDF } = await import('jspdf');
  let pdf: InstanceType<typeof jsPDF>;
  if (opts.pdfPage === 'image') {
    pdf = new jsPDF({ orientation: width >= height ? 'landscape' : 'portrait', unit: 'px', format: [width, height], hotfixes: ['px_scaling'] });
    pdf.addImage(dataUrl, 'PNG', 0, 0, width, height, undefined, 'FAST');
  } else {
    const landscape = opts.pdfPage === 'a4-landscape';
    pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const scale = Math.min((pw - margin * 2) / width, (ph - margin * 2) / height);
    const w = width * scale;
    const h = height * scale;
    pdf.addImage(dataUrl, 'PNG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
  }
  await saveBlob(pdf.output('blob'), `${opts.fileName}.pdf`, 'PDF');
}
