import { parse as pgParse } from 'libpg-query';
import { parseSql } from '../src/formats/sql/parse';
import type { ParsedSchema } from '../src/formats/common';

export async function sql(text: string): Promise<ParsedSchema> {
  const r = await parseSql(text, pgParse as never);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('\n'));
  return r.parsed;
}

export const emptyProject = () => ({ schema: { tables: [], enums: [], relationships: [] }, meta: {} });
