import type { DocContent, Id, Project } from '@erd/model/types';
import { normalizeDocContent } from '@erd/model/docContent';
import { slugify } from '@erd/model/naming';
import { computeModules, markdownToBlocks, type ModulesResult } from './modules';
import {
  CONV_HEADER,
  DASH,
  detectConventions,
  FIELD_HEADER,
  fieldRows,
  generatedBullets,
  indexSummary,
  REL_HEADER,
  relationshipRows,
  uniqueSummary,
  type Convention,
} from './derive';
import type { TableVariant } from './theme';

/** Árvore intermediária (§1.5): o que os testes comparam, o que a pré-visualização mostra, o que `render` formata */
export type Block =
  | { kind: 'cover'; title: string; subtitle: string; edition: string; scope: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; anchor?: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'table'; variant: TableVariant; header: string[]; rows: { cells: string[]; fill?: string }[] }
  | { kind: 'spacer' };

export interface Outline {
  blocks: Block[];
  footer: string;
  fileName: string;
}

export interface DocMeta {
  /** Nome do projeto (capa, rodapé, nome do arquivo) */
  projectName: string;
  /** Número da versão do documento ("versão N" na capa); 0 = pré-visualização */
  version: number;
  /** Data da publicação (capa `{data}` e `docProps/core.xml`) */
  publishedAt: Date;
}

export type PendingKind = 'cover' | 'intro' | 'convention-goal' | 'table-description' | 'column-description' | 'relationship-function';

export interface PendingItem {
  kind: PendingKind;
  label: string;
  tableId?: Id;
  columnId?: Id;
  /** Relação (ou `pivot:<id>`) e lado, para `relationship-function` */
  relKey?: Id;
  side?: 'from' | 'to';
  conventionKey?: string;
}

export interface ReviewTable {
  id: Id;
  name: string;
  columns: number;
  relationships: number;
}

export interface DocReview {
  modules: { key: string; title: string; module: string; responsibility: string | null; note: string | null; spellings: string[]; tables: ReviewTable[] }[];
  otherTables: ReviewTable[];
  conflicts: ModulesResult['conflicts'];
  emptyModules: string[];
  counts: { tables: number; columns: number; relationships: number; enums: number };
  conventions: Convention[];
  pending: PendingItem[];
  fileName: string;
}

export type DocProject = Pick<Project, 'schema' | 'meta' | 'notes'> & { doc?: DocContent };

const ENUM_FILL = 'EAF4EE';

export const MAIN_TITLE_FALLBACK = 'Dicionário de dados';

export function fileNameFor(content: DocContent, projectName: string) {
  const raw = content.fileName.trim() || `Modelo_Dados_${slugify(projectName).replace(/-/g, '_') || 'Projeto'}.docx`;
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '_');
  return /\.docx$/i.test(safe) ? safe : `${safe}.docx`;
}

const fmtDate = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });

export function fillTemplate(s: string, meta: DocMeta) {
  return s.replace(/\{projeto\}/g, meta.projectName).replace(/\{versao\}/g, String(meta.version)).replace(/\{data\}/g, fmtDate(meta.publishedAt));
}

/** Project + DocContent → árvore do documento e o resumo para a tela de revisão */
export function buildOutline(project: DocProject, meta: DocMeta): { outline: Outline; review: DocReview } {
  const content = normalizeDocContent(project.doc);
  const { schema } = project;
  const blocks: Block[] = [];
  const pending: PendingItem[] = [];
  const mods = computeModules(project);
  const table = (variant: TableVariant, header: string[], rows: { cells: string[]; fill?: string }[]) => {
    blocks.push({ kind: 'table', variant, header, rows });
    blocks.push({ kind: 'spacer' });
  };

  // capa
  const c = content.cover;
  if (!c.title.trim()) pending.push({ kind: 'cover', label: 'Título da capa' });
  if (!c.scope.trim()) pending.push({ kind: 'cover', label: 'Escopo (capa)' });
  const title = c.title.trim() || MAIN_TITLE_FALLBACK;
  blocks.push({
    kind: 'cover',
    title,
    subtitle: c.subtitle.trim() || meta.projectName,
    edition: fillTemplate(c.edition.trim() || '{projeto} — versão {versao}', meta),
    scope: fillTemplate(c.scope.trim(), meta) || DASH,
  });

  // 1. convenções
  blocks.push({ kind: 'heading', level: 1, text: '1. Convenções de modelagem' });
  if (!content.intro.trim()) pending.push({ kind: 'intro', label: 'Introdução das convenções' });
  for (const b of markdownToBlocks(content.intro)) blocks.push(b);
  if (!content.intro.trim()) blocks.push({ kind: 'paragraph', text: DASH });
  const conventions = detectConventions(schema, content);
  for (const cv of conventions) if (!cv.goal) pending.push({ kind: 'convention-goal', label: `Objetivo: ${cv.name}`, conventionKey: cv.key });
  table(
    'conventions',
    CONV_HEADER,
    conventions.map((cv) => ({ cells: [cv.name || DASH, cv.pattern || DASH, cv.goal || DASH] })),
  );

  // 2. índice de módulos
  blocks.push({ kind: 'heading', level: 1, text: '2. Índice de módulos' });
  const indexRows = mods.modules.map((m) => ({ cells: [m.module, m.responsibility ?? DASH, m.tables.map((t) => t.name).join(', ') || DASH] }));
  if (mods.others.length) indexRows.push({ cells: ['Outras tabelas', 'Tabelas sem módulo', mods.others.map((t) => t.name).join(', ')] });
  table('modules', ['Módulo', 'Responsabilidade', 'Tabelas'], indexRows.length ? indexRows : [{ cells: [DASH, DASH, DASH] }]);

  const relCount = new Map<Id, number>();
  const sections = [...mods.modules.map((m) => ({ title: m.title, note: m.note, tables: m.tables })), ...(mods.others.length ? [{ title: 'Outras tabelas', note: null, tables: mods.others }] : [])];
  for (const s of sections) {
    blocks.push({ kind: 'heading', level: 1, text: s.title });
    if (s.note) for (const b of markdownToBlocks(s.note.content)) blocks.push(b);
    for (const t of s.tables) {
      blocks.push({ kind: 'heading', level: 2, text: t.name, anchor: t.id });
      if (!t.comment?.trim()) pending.push({ kind: 'table-description', label: `Descrição de ${t.name}`, tableId: t.id });
      for (const b of markdownToBlocks(t.comment?.trim() || DASH)) blocks.push(b.kind === 'bullet' ? b : { kind: 'paragraph', text: b.text });
      for (const text of generatedBullets(t)) blocks.push({ kind: 'bullet', text });
      for (const rule of content.tables[t.id]?.rules ?? []) if (rule.trim()) blocks.push({ kind: 'bullet', text: rule.trim() });
      const fields = fieldRows(schema, t, content.typeStyle);
      for (const col of t.columns) if (!col.comment?.trim()) pending.push({ kind: 'column-description', label: `Descrição de ${t.name}.${col.name}`, tableId: t.id, columnId: col.id });
      table(
        'fields',
        FIELD_HEADER,
        fields.map((f) => ({ cells: [...f.cells], ...(f.isEnum ? { fill: ENUM_FILL } : {}) })),
      );
      const rels = relationshipRows(project as Project, t, content);
      relCount.set(t.id, rels.length);
      for (const r of rels)
        if (!r.hasFunction) pending.push({ kind: 'relationship-function', label: `Função de ${r.cells[0]}`, tableId: t.id, relKey: r.key, side: r.side });
      if (rels.length) {
        blocks.push({ kind: 'heading', level: 3, text: 'Relacionamentos e função' });
        table(
          'relationships',
          REL_HEADER,
          rels.map((r) => ({ cells: [...r.cells] })),
        );
      }
    }
  }

  // apêndices
  blocks.push({ kind: 'heading', level: 1, text: 'Apêndice A — Resumo das restrições UNIQUE' });
  const uniques = schema.tables.map((t) => ({ t, u: uniqueSummary(t) })).filter((x) => x.u.length);
  if (uniques.length) table('appendix', ['Tabela', 'Restrições UNIQUE'], uniques.map(({ t, u }) => ({ cells: [t.name, u.join('; ')] })));
  else blocks.push({ kind: 'paragraph', text: 'Nenhuma restrição UNIQUE além das chaves primárias.' });
  blocks.push({ kind: 'heading', level: 1, text: 'Apêndice B — Resumo dos índices recomendados' });
  const idx = schema.tables.map((t) => ({ t, i: indexSummary(t) })).filter((x) => x.i.length);
  if (idx.length) table('appendix', ['Tabela', 'Índices'], idx.map(({ t, i }) => ({ cells: [t.name, i.join('; ')] })));
  else blocks.push({ kind: 'paragraph', text: 'Nenhum índice além das chaves primárias e das restrições UNIQUE.' });

  const fileName = fileNameFor(content, meta.projectName);
  const reviewTable = (t: { id: Id; name: string; columns: unknown[] }): ReviewTable => ({ id: t.id, name: t.name, columns: t.columns.length, relationships: relCount.get(t.id) ?? 0 });
  const review: DocReview = {
    modules: mods.modules.map((m) => ({
      key: m.key,
      title: m.title,
      module: m.module,
      responsibility: m.responsibility,
      note: m.note?.title ?? null,
      spellings: m.spellings,
      tables: m.tables.map(reviewTable),
    })),
    otherTables: mods.others.map(reviewTable),
    conflicts: mods.conflicts,
    emptyModules: mods.empty,
    counts: {
      tables: schema.tables.length,
      columns: schema.tables.reduce((n, t) => n + t.columns.length, 0),
      relationships: schema.relationships.length,
      enums: schema.enums.length,
    },
    conventions,
    pending,
    fileName,
  };
  return { outline: { blocks, footer: `${meta.projectName} — ${title}`, fileName }, review };
}
