import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { Format } from '../model/types';

/** Modo CM6 mínimo para Prisma (não há pacote oficial) */
const prismaLanguage = StreamLanguage.define<{ inBlock: boolean }>({
  name: 'prisma',
  startState: () => ({ inBlock: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match('///')) {
      stream.skipToEnd();
      return 'docComment';
    }
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^@@?[\w.]+/)) return 'meta';
    if (stream.match(/^(model|enum|datasource|generator|view|type)\b/)) return 'keyword';
    if (stream.match(/^(String|Int|BigInt|Boolean|DateTime|Decimal|Float|Json|Bytes|Unsupported)\b/)) return 'typeName';
    if (stream.match(/^(true|false|null)\b/)) return 'atom';
    if (stream.match(/^-?\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^[A-Z]\w*/)) return 'className';
    if (stream.match(/^[a-z_]\w*/)) return 'variableName';
    if (stream.match(/^[{}]/)) {
      state.inBlock = stream.current() === '{';
      return 'brace';
    }
    if (stream.match(/^[?[\]()=,:]/)) return 'punctuation';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
});

export const LANGUAGES: Record<Format | 'markdown', Extension> = {
  sql: sql({ dialect: PostgreSQL }),
  prisma: prismaLanguage,
  drizzle: javascript({ typescript: true }),
  markdown: markdown(),
};
