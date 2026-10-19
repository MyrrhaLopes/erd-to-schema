import type { Format, Id, Project } from '@erd/model/types';
import { tableKey } from '@erd/model/schema';
import { computePrismaNames } from '@erd/model/formats/prisma/mapping';

/**
 * Blocos de topo de cada formato (§4.6): statements no SQL, `model`/`enum` no Prisma.
 * Um bloco cobre do primeiro token ao fim do statement; comentários e espaços entre
 * blocos ficam de fora, então mascarar um bloco quebrado nunca apaga as diretivas `@erd:`
 * nem os comentários livres ao redor.
 *
 * O Drizzle é executado, não parseado: o arquivo inteiro é um bloco só.
 */
export interface Block {
  from: number;
  to: number;
  /** Bloco de definição (CREATE TABLE/TYPE, model, enum): pode ser substituído pela versão do modelo */
  def: boolean;
  /** Chaves das tabelas tocadas (SQL: `schema.nome`; Prisma: nome do model) */
  tables: string[];
  enums: string[];
}

const SQL_TOP = /^(CREATE|ALTER|COMMENT|DROP)\b/i;
const PRISMA_TOP = /^(model|enum|datasource|generator|view|type)\b/;

export function splitBlocks(format: Format, text: string): Block[] {
  if (format === 'sql') return splitSql(text);
  if (format === 'prisma') return splitPrisma(text);
  const first = text.search(/\S/);
  if (first < 0) return [];
  return [{ from: first, to: text.trimEnd().length, def: true, tables: [], enums: [] }];
}

/* ------------------------------------------------------------------ */
/* SQL                                                                  */
/* ------------------------------------------------------------------ */

function splitSql(text: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  const n = text.length;
  let start = -1;
  const close = (end: number) => {
    if (start >= 0) {
      let e = end;
      while (e > start && /\s/.test(text[e - 1])) e--;
      out.push(identifySql(text, start, e));
    }
    start = -1;
  };
  while (i < n) {
    const c = text[i];
    // comentários e espaços fora de um statement não abrem bloco
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const endc = text.indexOf('*/', i + 2);
      i = endc < 0 ? n : endc + 2;
      continue;
    }
    if (/\s/.test(c)) {
      // statement sem `;` seguido de outro statement na coluna 0: fecha o anterior
      if (c === '\n' && start >= 0 && SQL_TOP.test(text.slice(i + 1, i + 12))) close(i);
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n && !(text[i] === q && text[i + 1] !== q)) i += text[i] === q ? 2 : 1;
      i++;
      continue;
    }
    if (c === '$') {
      const m = text.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (m) {
        const endq = text.indexOf(m[0], i + m[0].length);
        i = endq < 0 ? n : endq + m[0].length;
        continue;
      }
    }
    if (c === ';') {
      close(i + 1);
      i++;
      continue;
    }
    i++;
  }
  close(n);
  return out;
}

const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(${NAME}(?:\s*\.\s*${NAME})?)`;

const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase());

export function sqlKey(q: string): string {
  const parts = q.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(unquote);
  return parts.length > 1 ? tableKey({ schema: parts[0], name: parts[1] }) : tableKey({ name: parts[0] });
}

function identifySql(text: string, from: number, to: number): Block {
  const s = text.slice(from, to);
  const b: Block = { from, to, def: false, tables: [], enums: [] };
  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`, 'i')))) {
    b.def = true;
    b.tables.push(sqlKey(m[1]));
  } else if ((m = s.match(new RegExp(String.raw`^CREATE\s+TYPE\s+${QNAME}\s+AS\s+ENUM`, 'i')))) {
    b.def = true;
    b.enums.push(sqlKey(m[1]));
  } else if ((m = s.match(new RegExp(String.raw`^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QNAME}`, 'i')))) {
    b.tables.push(sqlKey(m[1]));
  } else if ((m = s.match(new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?${QNAME}`, 'i')))) {
    b.tables.push(sqlKey(m[1]));
  } else if ((m = s.match(new RegExp(String.raw`^COMMENT\s+ON\s+TABLE\s+${QNAME}`, 'i')))) {
    b.tables.push(sqlKey(m[1]));
  } else if ((m = s.match(new RegExp(String.raw`^COMMENT\s+ON\s+COLUMN\s+(${NAME}(?:\s*\.\s*${NAME})*)`, 'i')))) {
    const parts = m[1].split(/\s*\.\s*/);
    parts.pop();
    if (parts.length) b.tables.push(sqlKey(parts.join('.')));
  } else if ((m = s.match(/^CREATE\s+TABLE\s*$/i))) {
    b.def = true;
  }
  return b;
}

/* ------------------------------------------------------------------ */
/* Prisma                                                               */
/* ------------------------------------------------------------------ */

function splitPrisma(text: string): Block[] {
  const out: Block[] = [];
  const n = text.length;
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      lineStart = true;
      continue;
    }
    if (/\s/.test(c)) {
      lineStart = c === '\n' || lineStart;
      i++;
      continue;
    }
    const kw = text.slice(i).match(PRISMA_TOP);
    if (!kw) {
      // lixo fora de bloco: vira um bloco próprio até o fim da linha (o parser vai acusar)
      const nl = text.indexOf('\n', i);
      const e = nl < 0 ? n : nl;
      out.push({ from: i, to: e, def: false, tables: [], enums: [] });
      i = e;
      continue;
    }
    const from = i;
    let depth = 0;
    let opened = false;
    let end = -1;
    let j = i;
    while (j < n) {
      const d = text[j];
      if (d === '/' && text[j + 1] === '/') {
        const nl = text.indexOf('\n', j);
        j = nl < 0 ? n : nl;
        continue;
      }
      if (d === '"') {
        j++;
        while (j < n && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        j++;
        continue;
      }
      if (d === '{') {
        depth++;
        opened = true;
      } else if (d === '}') {
        depth--;
        if (opened && depth <= 0) {
          end = j + 1;
          break;
        }
      } else if (d === '\n' && j + 1 < n) {
        // bloco sem `}`: termina antes da próxima palavra-chave de topo ou diretiva na coluna 0
        const rest = text.slice(j + 1, j + 20);
        if (PRISMA_TOP.test(rest) || rest.startsWith('// @erd:')) {
          end = j;
          break;
        }
      }
      j++;
    }
    if (end < 0) end = n;
    let e = end;
    while (e > from && /\s/.test(text[e - 1])) e--;
    const head = text.slice(from, e).match(/^(model|view|enum)\s+([A-Za-z_]\w*)/);
    out.push({
      from,
      to: e,
      def: !!head,
      tables: head && head[1] !== 'enum' ? [head[2]] : [],
      enums: head && head[1] === 'enum' ? [head[2]] : [],
    });
    i = end;
    lineStart = false;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Nomes dos blocos ↔ IDs das entidades                                  */
/* ------------------------------------------------------------------ */

export interface NameIndex {
  tables: Map<string, Id>;
  enums: Map<string, Id>;
}

/** Como cada formato chama as tabelas e enums de um modelo (para casar blocos com IDs) */
export function nameIndex(format: Format, project: Pick<Project, 'schema' | 'meta'>): NameIndex {
  const idx: NameIndex = { tables: new Map(), enums: new Map() };
  if (format === 'prisma') {
    const names = computePrismaNames(project);
    for (const [id, n] of names.model) idx.tables.set(n, id);
    for (const e of project.schema.enums) idx.enums.set(names.enumName.get(e.name) ?? e.name, e.id);
    return idx;
  }
  for (const t of project.schema.tables) idx.tables.set(tableKey(t), t.id);
  for (const e of project.schema.enums) idx.enums.set(tableKey(e), e.id);
  return idx;
}

/** IDs das entidades tocadas por um bloco; no Drizzle (arquivo inteiro), todas */
export function blockIds(format: Format, b: Block, idx: NameIndex): Id[] {
  if (format === 'drizzle') return [...idx.tables.values(), ...idx.enums.values()];
  const out: Id[] = [];
  for (const k of b.tables) {
    const id = idx.tables.get(k);
    if (id) out.push(id);
  }
  for (const k of b.enums) {
    const id = idx.enums.get(k);
    if (id) out.push(id);
  }
  return out;
}
