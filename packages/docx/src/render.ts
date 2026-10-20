import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Block, Outline } from './outline';
import { headerFill, THEME } from './theme';

const font = THEME.font;
const run = (text: string, o: { size?: number; bold?: boolean; color?: string } = {}) => new TextRun({ text, font, ...o });

const border = { style: BorderStyle.SINGLE, size: THEME.table.border.size, color: THEME.table.border.color };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

function cell(text: string, o: { header?: boolean; fill?: string; width: number }) {
  const t = THEME.table;
  return new TableCell({
    width: { size: o.width, type: WidthType.DXA },
    ...(o.fill ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } } : {}),
    children: text.split('\n').map(
      (line) =>
        new Paragraph({
          spacing: { before: 0, after: 0, line: 240 },
          children: [run(line, o.header ? { size: t.header.size, bold: true, color: t.header.color } : { size: t.body.size, color: t.body.color })],
        }),
    ),
  });
}

function table(b: Extract<Block, { kind: 'table' }>) {
  const n = b.header.length;
  const w = Math.floor(THEME.table.width / n);
  const widths = Array.from({ length: n }, (_, i) => (i === n - 1 ? THEME.table.width - w * (n - 1) : w));
  return new Table({
    width: { size: THEME.table.width, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    alignment: AlignmentType.CENTER,
    borders,
    rows: [
      new TableRow({ tableHeader: true, children: b.header.map((h, i) => cell(h, { header: true, fill: headerFill(b.variant), width: widths[i] })) }),
      ...b.rows.map((r) => new TableRow({ children: r.cells.map((c, i) => cell(c, { fill: r.fill, width: widths[i] })) })),
    ],
  });
}

function blocks(list: Block[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const c = THEME.cover;
  for (const b of list) {
    switch (b.kind) {
      case 'cover':
        out.push(
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: c.title.before }, children: [run(b.title, { size: c.title.size, bold: true, color: c.title.color })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run(b.subtitle, { size: c.subtitle.size, color: c.subtitle.color })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run(b.edition, { size: c.edition.size })] }),
          new Paragraph({ children: [] }),
          new Paragraph({ children: [run(b.scope, { size: c.scope.size })] }),
        );
        break;
      case 'heading':
        out.push(
          new Paragraph({
            heading: b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
            children: [run(b.text)],
          }),
        );
        break;
      case 'paragraph':
        out.push(new Paragraph({ spacing: { after: THEME.description.after }, children: [run(b.text, { size: THEME.description.size })] }));
        break;
      case 'bullet':
        out.push(
          new Paragraph({
            indent: { left: THEME.bullet.indent },
            spacing: { after: THEME.bullet.after },
            children: [run(THEME.bullet.prefix + b.text, { size: THEME.bullet.size })],
          }),
        );
        break;
      case 'table':
        out.push(table(b));
        break;
      case 'spacer':
        out.push(new Paragraph({ children: [] }));
        break;
    }
  }
  return out;
}

const heading = (id: string, name: string, h: { size: number; color: string }, extra: { pageBreakBefore?: boolean; before?: number } = {}) => ({
  id,
  name,
  basedOn: 'Normal',
  next: 'Normal',
  quickFormat: true,
  run: { font, size: h.size, bold: true, color: h.color },
  paragraph: { keepNext: true, ...(extra.pageBreakBefore ? { pageBreakBefore: true } : {}), spacing: { before: extra.before ?? 200, after: 120 } },
});

export function toDocument(outline: Outline, meta: { title: string; creator: string }) {
  const p = THEME.page;
  return new Document({
    creator: meta.creator,
    title: meta.title,
    lastModifiedBy: meta.creator,
    styles: {
      default: {
        document: {
          run: { font, size: THEME.body.size },
          paragraph: { spacing: { after: THEME.body.after, line: THEME.body.line } },
        },
      },
      paragraphStyles: [
        heading('Heading1', 'Heading 1', THEME.heading1, { pageBreakBefore: true, before: THEME.heading1.before }),
        heading('Heading2', 'Heading 2', THEME.heading2),
        heading('Heading3', 'Heading 3', THEME.heading3),
      ],
    },
    sections: [
      {
        properties: {
          page: {
            // o docx troca largura e altura sozinho quando a orientação é paisagem
            size: { width: p.height, height: p.width, orientation: PageOrientation.LANDSCAPE },
            margin: { ...p.margin, header: 425, footer: 425 },
          },
        },
        footers: {
          default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(outline.footer, { size: THEME.footer.size })] })] }),
        },
        children: blocks(outline.blocks),
      },
    ],
  });
}

/**
 * Empacota de forma determinística: mesma entrada, mesmos bytes. O `docx` grava a hora atual
 * no `docProps/core.xml` e nas entradas do zip; aqui as duas viram `publishedAt`.
 */
export async function pack(outline: Outline, meta: { title: string; creator: string; publishedAt: Date }): Promise<Uint8Array> {
  const raw = new Uint8Array(await Packer.toArrayBuffer(toDocument(outline, meta)));
  const files = unzipSync(raw);
  const iso = meta.publishedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (files['docProps/core.xml']) {
    const xml = strFromU8(files['docProps/core.xml']).replace(
      /(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g,
      (_m, open: string, _k: string, close: string) => `${open}${iso}${close}`,
    );
    files['docProps/core.xml'] = strToU8(xml);
  }
  // o zip guarda a data em hora local do DOS; com uma data fixa e nomes ordenados, os bytes não mudam
  const mtime = new Date(Date.UTC(2020, 0, 1));
  const ordered = Object.keys(files).sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : a.localeCompare(b)));
  return zipSync(Object.fromEntries(ordered.map((k) => [k, [files[k], { mtime, level: 6 }]])) as never);
}
