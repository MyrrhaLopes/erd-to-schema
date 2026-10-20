import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';
import { buildProjectZip, readProjectZip } from '../src/projectFile';
import { emptyProject } from '../src/project';
import { noteToMarkdown, parseNoteMarkdown } from '../src/notes';

describe('project zip', () => {
  it('notes survive export/reimport as individual .md files', () => {
    const p = emptyProject('Loja');
    p.notes.push({ id: 'n1', title: 'Regras de negócio', content: '# Pedidos\n\n- item 1', color: 'blue' });
    p.notes.push({ id: 'n2', title: 'Regras de negócio', content: 'outra' });
    p.layout.n1 = { x: 1, y: 2, w: 200, h: 100 };
    const zip = buildProjectZip(p);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(
      ['notes/regras-de-negocio-2.md', 'notes/regras-de-negocio.md', 'project.json', 'schema.prisma', 'schema.sql', 'schema.ts'].sort(),
    );
    // edita o .md fora da ferramenta e adiciona uma nota nova
    files['notes/regras-de-negocio.md'] = strToU8(strFromU8(files['notes/regras-de-negocio.md']).replace('item 1', 'item editado'));
    files['notes/nova.md'] = strToU8('# Nova nota\n\ntexto');
    const r = readProjectZip(zipSync(files));
    expect(r.kind).toBe('project');
    if (r.kind !== 'project') return;
    expect(r.project.notes).toHaveLength(3);
    expect(r.project.notes[0]).toMatchObject({ id: 'n1', title: 'Regras de negócio', color: 'blue', content: '# Pedidos\n\n- item editado' });
    expect(r.project.notes[2]).toMatchObject({ title: 'Nova nota' });
    expect(r.project.layout.n1).toEqual({ x: 1, y: 2, w: 200, h: 100 });
  });

  it('front matter round trip', () => {
    const md = noteToMarkdown({ id: 'x', title: 'Título "com aspas"', content: 'corpo' });
    expect(parseNoteMarkdown(md, 'f')).toMatchObject({ id: 'x', title: 'Título "com aspas"', content: 'corpo' });
  });
});
