import type { Block, Outline } from './outline';
import { headerFill, THEME } from './theme';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pt = (halfPoints: number) => `${halfPoints / 2}pt`;

/**
 * Pré-visualização em HTML a partir do outline, com o mesmo visual do .docx (cores, tamanhos,
 * tabelas). Cada Heading 1 começa uma "página" (a quebra de página do Word).
 */
export function outlineToHtml(outline: Outline): string {
  const parts: string[] = [];
  const page = () => parts.push('</section><section class="docx-page">');
  for (const b of outline.blocks) parts.push(block(b, page));
  const css = `
.docx-root{font-family:${THEME.font},sans-serif;font-size:${pt(THEME.body.size)};color:#000;background:#e5e7eb;padding:12px}
.docx-page{background:#fff;margin:0 auto 12px;padding:28px 24px;max-width:1100px;box-shadow:0 1px 3px rgba(0,0,0,.15);position:relative}
.docx-page::after{content:attr(data-footer);display:block;text-align:center;font-size:${pt(THEME.footer.size)};color:#475569;margin-top:16px}
.docx-root p{margin:0 0 ${THEME.description.after / 20}pt}
.docx-root h1{font-weight:bold;font-size:${pt(THEME.heading1.size)};color:#${THEME.heading1.color};margin:0 0 6pt}
.docx-root h2{font-weight:bold;font-size:${pt(THEME.heading2.size)};color:#${THEME.heading2.color};margin:10pt 0 4pt}
.docx-root h3{font-weight:bold;font-size:${pt(THEME.heading3.size)};color:#${THEME.heading3.color};margin:8pt 0 4pt}
.docx-root .bullet{font-size:${pt(THEME.bullet.size)};margin:0 0 2pt ${THEME.bullet.indent / 20}pt}
.docx-root table{width:100%;table-layout:fixed;border-collapse:collapse;margin:0 auto 10pt}
.docx-root td,.docx-root th{border:0.5pt solid #000;padding:1pt 3pt;font-size:${pt(THEME.table.body.size)};vertical-align:top;overflow-wrap:anywhere;text-align:left}
.docx-root th{color:#fff;font-weight:bold;font-size:${pt(THEME.table.header.size)}}
.docx-cover{text-align:center;padding-top:${THEME.cover.title.before / 20}pt}
.docx-cover .t{font-size:${pt(THEME.cover.title.size)};font-weight:bold;color:#${THEME.cover.title.color}}
.docx-cover .s{font-size:${pt(THEME.cover.subtitle.size)};color:#${THEME.cover.subtitle.color}}
.docx-cover .e{font-size:${pt(THEME.cover.edition.size)}}
.docx-scope{font-size:${pt(THEME.cover.scope.size)};margin-top:12pt}`;
  return `<style>${css}</style><div class="docx-root"><section class="docx-page">${parts.join('')}</section></div>`
    .replace(/<section class="docx-page">/g, `<section class="docx-page" data-footer="${esc(outline.footer)}">`)
    .replace(/<section class="docx-page"[^>]*><\/section>/g, '');
}

function block(b: Block, page: () => void): string {
  switch (b.kind) {
    case 'cover':
      return `<div class="docx-cover"><div class="t">${esc(b.title)}</div><div class="s">${esc(b.subtitle)}</div><div class="e">${esc(b.edition)}</div></div><p class="docx-scope">${esc(b.scope)}</p>`;
    case 'heading':
      if (b.level === 1) page();
      return `<h${b.level}${b.anchor ? ` data-table-id="${esc(b.anchor)}"` : ''}>${esc(b.text)}</h${b.level}>`;
    case 'paragraph':
      return `<p>${esc(b.text)}</p>`;
    case 'bullet':
      return `<p class="bullet">${esc(THEME.bullet.prefix + b.text)}</p>`;
    case 'table': {
      const fill = headerFill(b.variant);
      const head = `<tr>${b.header.map((h) => `<th style="background:#${fill}">${esc(h)}</th>`).join('')}</tr>`;
      const rows = b.rows.map((r) => `<tr${r.fill ? ` style="background:#${r.fill}"` : ''}>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
      return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
    }
    case 'spacer':
      return '';
  }
}
