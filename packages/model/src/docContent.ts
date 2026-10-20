import type { DocContent, Id } from './types';

export const emptyDocContent = (): DocContent => ({
  cover: { title: '', subtitle: '', edition: '', scope: '' },
  intro: '',
  conventions: { detected: {}, extra: [] },
  tables: {},
  relationships: {},
  typeStyle: 'prisma',
  fileName: '',
});

/** Completa um formulário parcial (import de .zip antigo, JSON escrito à mão) com os padrões */
export function normalizeDocContent(raw: Partial<DocContent> | undefined | null): DocContent {
  const e = emptyDocContent();
  if (!raw || typeof raw !== 'object') return e;
  return {
    cover: { ...e.cover, ...(raw.cover ?? {}) },
    intro: raw.intro ?? '',
    conventions: { detected: { ...(raw.conventions?.detected ?? {}) }, extra: [...(raw.conventions?.extra ?? [])] },
    tables: { ...(raw.tables ?? {}) },
    relationships: { ...(raw.relationships ?? {}) },
    typeStyle: raw.typeStyle === 'sql' ? 'sql' : 'prisma',
    fileName: raw.fileName ?? '',
  };
}

/**
 * Forma achatada do formulário no Y.Doc (raiz `doc`): uma chave por campo, para que duas
 * pessoas preenchendo campos diferentes ao mesmo tempo não se sobrescrevam (LWW por campo).
 * Campos vazios não são gravados.
 */
export function flattenDocContent(d: DocContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (k: string, v: string | undefined) => {
    if (v) out[k] = v;
  };
  str('cover.title', d.cover.title);
  str('cover.subtitle', d.cover.subtitle);
  str('cover.edition', d.cover.edition);
  str('cover.scope', d.cover.scope);
  str('intro', d.intro);
  if (d.typeStyle !== 'prisma') out.typeStyle = d.typeStyle;
  str('fileName', d.fileName);
  for (const [k, v] of Object.entries(d.conventions.detected)) str(`conv:${k}`, v.goal);
  if (d.conventions.extra.length) out.extra = d.conventions.extra.map((x) => ({ name: x.name, pattern: x.pattern, goal: x.goal }));
  for (const [id, v] of Object.entries(d.tables)) if (v.rules.length) out[`rules:${id}`] = [...v.rules];
  for (const [id, v] of Object.entries(d.relationships)) {
    const r: { fromSide?: string; toSide?: string } = {};
    if (v.fromSide) r.fromSide = v.fromSide;
    if (v.toSide) r.toSide = v.toSide;
    if (r.fromSide || r.toSide) out[`rel:${id}`] = r;
  }
  return out;
}

export function unflattenDocContent(flat: Record<string, unknown>): DocContent {
  const d = emptyDocContent();
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  for (const [k, v] of Object.entries(flat)) {
    if (k === 'cover.title') d.cover.title = s(v);
    else if (k === 'cover.subtitle') d.cover.subtitle = s(v);
    else if (k === 'cover.edition') d.cover.edition = s(v);
    else if (k === 'cover.scope') d.cover.scope = s(v);
    else if (k === 'intro') d.intro = s(v);
    else if (k === 'typeStyle') d.typeStyle = v === 'sql' ? 'sql' : 'prisma';
    else if (k === 'fileName') d.fileName = s(v);
    else if (k === 'extra' && Array.isArray(v)) d.conventions.extra = v.map((x) => ({ name: s(x?.name), pattern: s(x?.pattern), goal: s(x?.goal) }));
    else if (k.startsWith('conv:')) d.conventions.detected[k.slice(5)] = { goal: s(v) };
    else if (k.startsWith('rules:') && Array.isArray(v)) d.tables[k.slice(6) as Id] = { rules: v.filter((x): x is string => typeof x === 'string') };
    else if (k.startsWith('rel:') && v && typeof v === 'object') {
      const r = v as { fromSide?: unknown; toSide?: unknown };
      const e: { fromSide?: string; toSide?: string } = {};
      if (typeof r.fromSide === 'string') e.fromSide = r.fromSide;
      if (typeof r.toSide === 'string') e.toSide = r.toSide;
      d.relationships[k.slice(4) as Id] = e;
    }
  }
  return d;
}

/** Entradas do formulário presas a tabelas ou relações que não existem mais */
export function orphanDocEntries(d: DocContent, tableIds: Set<Id>, relIds: Set<Id>) {
  return {
    tables: Object.keys(d.tables).filter((id) => !tableIds.has(id)),
    relationships: Object.keys(d.relationships).filter((id) => !relIds.has(id)),
  };
}
