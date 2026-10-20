import type { Id, NoteBlock, Project, Table } from '@erd/model/types';
import { effectiveTags } from '@erd/model/tags';

/** Tag de módulo: "Módulo A — Cadastro e Pessoas" (acento e maiúsculas não importam) */
export const MODULE_RE = /^m[óo]dulo\s+(.+)$/i;

/** Normaliza para comparar: sem acento, minúsculas, espaços simples */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function isModuleTag(tag: string) {
  return MODULE_RE.test(tag.trim());
}

/** "Módulo A — Cadastro e Pessoas" → { module: 'Módulo A', responsibility: 'Cadastro e Pessoas' } */
export function splitModuleTag(tag: string): { module: string; responsibility: string | null } {
  const t = tag.trim().replace(/\s+/g, ' ');
  const m = t.match(/^(.+?)\s+[—–-]\s+(.+)$/) ?? t.match(/^(.+?)\s*:\s*(.+)$/);
  if (!m) return { module: t, responsibility: null };
  return { module: m[1].trim(), responsibility: m[2].trim() };
}

export interface ModuleInfo {
  /** Chave de comparação (o `X` normalizado) */
  key: string;
  /** Grafia usada no documento (a primeira encontrada, na ordem do canvas) */
  title: string;
  module: string;
  responsibility: string | null;
  /** Todas as grafias encontradas (mais de uma → aviso na revisão) */
  spellings: string[];
  note: NoteBlock | null;
  tables: Table[];
}

export interface ModuleConflict {
  tableId: Id;
  tableName: string;
  modules: string[];
  chosen: string;
}

export interface ModulesResult {
  modules: ModuleInfo[];
  /** Tabelas sem tag de módulo (vão para "Outras tabelas") */
  others: Table[];
  conflicts: ModuleConflict[];
  /** Tags de módulo sem nenhuma tabela */
  empty: string[];
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/**
 * Módulos a partir das tags do canvas (§1.2): ordem natural do `X`, tabela com duas tags de
 * módulo entra no primeiro da ordem, e a nota com o mesmo título da tag vira a descrição.
 */
export function computeModules(project: Pick<Project, 'schema' | 'meta' | 'notes'>): ModulesResult {
  const p = project as Project;
  const byKey = new Map<string, ModuleInfo>();
  const tagsOf = new Map<Id, string[]>();
  const touch = (tag: string) => {
    const x = tag.trim().match(MODULE_RE)![1];
    const key = fold(x);
    let m = byKey.get(key);
    if (!m) {
      const { module, responsibility } = splitModuleTag(tag);
      m = { key, title: tag.trim().replace(/\s+/g, ' '), module, responsibility, spellings: [], note: null, tables: [] };
      byKey.set(key, m);
    }
    const spelled = tag.trim().replace(/\s+/g, ' ');
    if (!m.spellings.includes(spelled)) m.spellings.push(spelled);
    return key;
  };
  for (const t of p.schema.tables) {
    const keys = [...new Set(effectiveTags(p, t.id).filter(isModuleTag).map(touch))];
    tagsOf.set(t.id, keys);
  }
  // tags de módulo só em enums: aparecem como módulo sem tabela
  for (const e of p.schema.enums) for (const tag of p.meta[e.id]?.tags ?? []) if (isModuleTag(tag)) touch(tag);

  const ordered = [...byKey.values()].sort((a, b) => collator.compare(a.key, b.key));
  const rank = new Map(ordered.map((m, i) => [m.key, i]));
  const conflicts: ModuleConflict[] = [];
  const others: Table[] = [];
  for (const t of p.schema.tables) {
    const keys = (tagsOf.get(t.id) ?? []).sort((a, b) => rank.get(a)! - rank.get(b)!);
    if (!keys.length) {
      others.push(t);
      continue;
    }
    const first = byKey.get(keys[0])!;
    first.tables.push(t);
    if (keys.length > 1) conflicts.push({ tableId: t.id, tableName: t.name, modules: keys.map((k) => byKey.get(k)!.title), chosen: first.title });
  }
  for (const m of ordered) {
    const folded = m.spellings.map(fold);
    m.note = p.notes.find((n) => folded.includes(fold(n.title))) ?? null;
  }
  return { modules: ordered, others, conflicts, empty: ordered.filter((m) => !m.tables.length).map((m) => m.title) };
}

/**
 * Markdown da nota → blocos de texto simples: parágrafos e itens com marcador ("• ").
 * Títulos, ênfase, código e links perdem a marcação; o texto fica.
 */
export function markdownToBlocks(md: string): { kind: 'paragraph' | 'bullet'; text: string }[] {
  const out: { kind: 'paragraph' | 'bullet'; text: string }[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'paragraph', text: para.join(' ') });
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      continue;
    }
    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (bullet) {
      flush();
      out.push({ kind: 'bullet', text: inline(bullet[1]) });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ kind: 'paragraph', text: inline(heading[1]) });
      continue;
    }
    para.push(inline(line.replace(/^>\s?/, '')));
  }
  flush();
  return out.filter((b) => b.text);
}

function inline(s: string) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .trim();
}
