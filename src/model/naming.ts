import { nanoid } from 'nanoid';

export const newId = (prefix = '') => prefix + nanoid(10);

export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function camelCase(name: string): string {
  const words = splitWords(name);
  if (words.length === 0) return name;
  const out = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return /^[0-9]/.test(out) ? '_' + out : out;
}

export function pascalCase(name: string): string {
  const c = camelCase(name);
  return c.startsWith('_') ? c : c[0].toUpperCase() + c.slice(1);
}

export function snakeCase(name: string): string {
  return splitWords(name)
    .map((w) => w.toLowerCase())
    .join('_');
}

const IRREGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  data: 'data',
  media: 'media',
  status: 'status',
  news: 'news',
};

export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR[lower]) return matchCase(word, IRREGULAR[lower]);
  if (/ies$/i.test(word) && word.length > 4) return word.slice(0, -3) + matchCase(word.slice(-3), 'y');
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/es$/i.test(word) && /(x|ch|sh|ss|z|us)$/i.test(word.slice(0, -2))) return word.slice(0, -2);
  if (/s$/i.test(word) && word.length > 2) return word.slice(0, -1);
  return word;
}

export function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

function matchCase(sample: string, word: string) {
  return sample[0] === sample[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
}

/** Nome de model Prisma derivado de um nome de tabela: `user_roles` → `UserRole` */
export function modelNameFor(table: string): string {
  const words = splitWords(table);
  if (words.length === 0) return 'Model';
  words[words.length - 1] = singularize(words[words.length - 1]);
  return pascalCase(words.join('_'));
}

const SQL_RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate ' +
    'collation column concurrently constraint create cross current_catalog current_date current_role ' +
    'current_schema current_time current_timestamp current_user default deferrable desc distinct do else ' +
    'end except false fetch for foreign freeze from full grant group having ilike in initially inner ' +
    'intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not ' +
    'notnull null offset on only or order outer overlaps placing primary references returning right select ' +
    'session_user similar some symmetric system_user table tablesample then to trailing true union unique ' +
    'user using variadic verbose when where window with'
  ).split(' '),
);

/** Quota um identificador SQL quando necessário */
export function qi(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !SQL_RESERVED.has(name)) return name;
  return '"' + name.replace(/"/g, '""') + '"';
}

export function sqlString(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Gera um nome único adicionando sufixo numérico */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(base + i)) i++;
  return base + i;
}

export function isValidJsIdent(s: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

export function slugify(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'nota'
  );
}
