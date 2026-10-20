import { describe, expect, it } from 'vitest';
import { directiveLines, splitTags } from '../src/formats/common';
import { generatePrisma } from '../src/formats/prisma/generate';
import { parsePrisma } from '../src/formats/prisma/parse';
import { emptyProject as project } from '../src/project';
import { sql } from './helpers';

describe('tags com espaço (módulos do documento Word)', () => {
  it('splitTags aceita aspas, vírgulas e espaços', () => {
    expect(splitTags('core, "Módulo A — Cadastro e Pessoas" auth')).toEqual(['core', 'Módulo A — Cadastro e Pessoas', 'auth']);
    expect(splitTags('"com \\"aspas\\""')).toEqual(['com "aspas"']);
  });

  it('ida e volta pelo SQL e pelo Prisma', async () => {
    const parsed = await sql(`CREATE TABLE users (id int PRIMARY KEY);\n-- @erd:tags users core, "Módulo A — Cadastro e Pessoas"`);
    const id = parsed.schema.tables[0].id;
    expect(parsed.meta[id].tags).toEqual(['core', 'Módulo A — Cadastro e Pessoas']);
    const p = { ...project('X'), schema: parsed.schema, meta: parsed.meta };
    expect(directiveLines(p, 'sql')).toContain('-- @erd:tags users core, "Módulo A — Cadastro e Pessoas"');
    const back = parsePrisma(generatePrisma(p));
    if (!back.ok) throw new Error('prisma');
    expect(Object.values(back.parsed.meta)[0].tags).toEqual(['core', 'Módulo A — Cadastro e Pessoas']);
  });
});
