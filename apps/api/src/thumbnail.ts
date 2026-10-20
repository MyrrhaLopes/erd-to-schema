import type { ProjectDoc } from '@erd/crdt';

const W = 320;
const H = 180;
const PAD = 12;

/**
 * Miniatura do canvas (fase 6) como SVG, desenhada a partir do layout projetado
 * (`json_snapshot`): retângulos de tabelas, enums e notas e linhas das relações. Sem
 * navegador no servidor e sem texto (ilegível nesse tamanho).
 */
export function renderThumbnail(doc: Pick<ProjectDoc, 'schema' | 'layout' | 'notes'> | null): string {
  type Box = { id: string; x: number; y: number; w: number; h: number; kind: 'table' | 'enum' | 'note' };
  const boxes: Box[] = [];
  if (doc) {
    for (const t of doc.schema.tables) {
      const l = doc.layout[t.id];
      if (l) boxes.push({ id: t.id, x: l.x, y: l.y, w: l.w ?? 260, h: 46 + 26 * t.columns.length, kind: 'table' });
    }
    for (const e of doc.schema.enums) {
      const l = doc.layout[e.id];
      if (l) boxes.push({ id: e.id, x: l.x, y: l.y, w: l.w ?? 180, h: 46 + 22 * e.values.length, kind: 'enum' });
    }
    for (const n of doc.notes) {
      const l = doc.layout[n.id];
      if (l) boxes.push({ id: n.id, x: l.x, y: l.y, w: l.w ?? 260, h: l.h ?? 180, kind: 'note' });
    }
  }
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`, `<rect width="${W}" height="${H}" fill="#f8fafc"/>`];
  if (boxes.length) {
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const s = Math.min((W - PAD * 2) / Math.max(1, maxX - minX), (H - PAD * 2) / Math.max(1, maxY - minY), 0.6);
    const ox = (W - (maxX - minX) * s) / 2 - minX * s;
    const oy = (H - (maxY - minY) * s) / 2 - minY * s;
    const r = (n: number) => Math.round(n * 10) / 10;
    const byId = new Map(boxes.map((b) => [b.id, b]));
    for (const rel of doc!.schema.relationships) {
      const a = byId.get(rel.fromTable);
      const b = byId.get(rel.toTable);
      if (!a || !b || a === b) continue;
      const dash = rel.kind === 'note' ? ' stroke-dasharray="3 2"' : '';
      out.push(
        `<line x1="${r(ox + (a.x + a.w / 2) * s)}" y1="${r(oy + (a.y + a.h / 2) * s)}" x2="${r(ox + (b.x + b.w / 2) * s)}" y2="${r(oy + (b.y + b.h / 2) * s)}" stroke="${rel.kind === 'note' ? '#c084fc' : '#94a3b8'}" stroke-width="1"${dash}/>`,
      );
    }
    const fill = { table: ['#ffffff', '#c7d2fe', '#a5b4fc'], enum: ['#ffffff', '#a7f3d0', '#6ee7b7'], note: ['#fffbeb', '#fde68a', '#fcd34d'] } as const;
    for (const b of boxes) {
      const [bg, head, stroke] = fill[b.kind];
      const x = r(ox + b.x * s);
      const y = r(oy + b.y * s);
      const w = r(Math.max(2, b.w * s));
      const h = r(Math.max(2, b.h * s));
      out.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r(Math.min(3, w / 4))}" fill="${bg}" stroke="${stroke}" stroke-width="0.8"/>`,
        `<rect x="${x}" y="${y}" width="${w}" height="${r(Math.min(h, 38 * s))}" rx="${r(Math.min(3, w / 4))}" fill="${head}"/>`,
      );
    }
  }
  out.push('</svg>');
  return out.join('');
}
