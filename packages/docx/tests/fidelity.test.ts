import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { strFromU8, unzipSync } from 'fflate';
import { buildDataDictionary, buildOutline, contentHash, type Block } from '../src';
import { cessProject, fromSql } from './helpers';

/**
 * Fidelidade ao documento de referência (drive-docx-plan §11): o .docx gerado da fixture CESS
 * é aberto e o XML é comparado com os valores medidos na referência (§1.1).
 * Diferenças esperadas em relação à referência (o gerador reproduz os valores, não o XML):
 *  - sem `customXML` do Google Docs nem ids de revisão (`w:rsid*`);
 *  - estilos de título com nomes padrão do Word (Heading1..3) em vez dos do python-docx.
 */
const meta = { projectName: 'CESS', version: 7, publishedAt: new Date('2026-10-20T12:00:00Z') };

async function xmlOf() {
  const { bytes, outline } = await buildDataDictionary(await cessProject(), meta);
  const files = unzipSync(bytes);
  const read = (k: string) => strFromU8(files[k]);
  const footer = Object.keys(files).find((k) => /^word\/footer\d*\.xml$/.test(k))!;
  return { bytes, outline, files, doc: read('word/document.xml'), styles: read('word/styles.xml'), footer: read(footer), core: read('docProps/core.xml') };
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('fidelidade ao documento de referência', () => {
  it('página A4 paisagem com as margens da referência', async () => {
    const { doc } = await xmlOf();
    expect(doc).toMatch(/<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
    expect(doc).toMatch(/<w:pgMar w:top="794" w:right="680" w:bottom="794" w:left="680"/);
  });

  it('fonte padrão, títulos com cor, tamanho e quebra de página no Heading 1', async () => {
    const { styles } = await xmlOf();
    expect(styles).toMatch(/<w:docDefaults>[\s\S]*w:ascii="Arial"[\s\S]*<w:sz w:val="18"\/>[\s\S]*<\/w:docDefaults>/);
    expect(styles).toMatch(/<w:docDefaults>[\s\S]*<w:spacing w:after="200" w:line="276"\/>[\s\S]*<\/w:docDefaults>/);
    const style = (id: string) => styles.match(new RegExp(`<w:style [^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`))![0];
    expect(style('Heading1')).toMatch(/<w:pageBreakBefore\/>/);
    expect(style('Heading1')).toMatch(/<w:color w:val="0B5731"\/>[\s\S]*<w:sz w:val="34"\/>|<w:sz w:val="34"\/>[\s\S]*<w:color w:val="0B5731"\/>/);
    expect(style('Heading1')).toMatch(/w:before="480"/);
    expect(style('Heading2')).toMatch(/0F6F3D/);
    expect(style('Heading2')).toMatch(/<w:sz w:val="26"\/>/);
    expect(style('Heading3')).toMatch(/16834A/);
    expect(style('Heading3')).toMatch(/<w:sz w:val="22"\/>/);
    expect(style('Heading2')).not.toMatch(/pageBreakBefore/);
  });

  it('capa', async () => {
    const { doc } = await xmlOf();
    const first = doc.match(/<w:p>[\s\S]*?<\/w:p>/)![0];
    expect(first).toMatch(/<w:jc w:val="center"\/>/);
    expect(first).toMatch(/w:before="1000"/);
    expect(first).toMatch(/<w:b\/>/);
    expect(first).toMatch(/<w:color w:val="0B5731"\/>/);
    expect(first).toMatch(/<w:sz w:val="52"\/>/);
    expect(first).toMatch(/Modelo de Dados/);
    expect(doc).toMatch(/<w:sz w:val="32"\/>[\s\S]{0,200}Sistema CESS/);
    expect(doc).toMatch(/CESS — versão 7/);
  });

  it('tabelas: largura, colunas iguais, layout fixo, centralizadas, bordas, cabeçalho e linhas de enum', async () => {
    const { doc, outline } = await xmlOf();
    const tables = doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g)!;
    const expected = outline.blocks.filter((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table');
    expect(tables).toHaveLength(expected.length);
    tables.forEach((t, i) => {
      const b = expected[i];
      expect(t).toMatch(/<w:tblW w:type="dxa" w:w="15477"\/>/);
      expect(t).toMatch(/<w:tblLayout w:type="fixed"\/>/);
      expect(t).toMatch(/<w:jc w:val="center"\/>/);
      expect(t).toMatch(/<w:insideH w:val="single" w:color="000000" w:sz="4"\/>|<w:insideH [^>]*w:sz="4"/);
      const cols = [...t.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
      expect(cols).toHaveLength(b.header.length);
      expect(cols.reduce((a, x) => a + x, 0)).toBe(15477);
      expect(Math.max(...cols) - Math.min(...cols)).toBeLessThanOrEqual(b.header.length);
      expect(count(t, /<w:tr>/g)).toBe(b.rows.length + 1);
      const header = t.match(/<w:tr>[\s\S]*?<\/w:tr>/)![0];
      expect(header).toMatch(/<w:tblHeader\/>/);
      expect(header).toMatch(new RegExp(`w:fill="${b.variant === 'relationships' ? '16834A' : '0B5731'}"`));
      expect(header).toMatch(/<w:color w:val="FFFFFF"\/>/);
      expect(header).toMatch(/<w:sz w:val="15"\/>/);
      expect(count(t, /w:fill="EAF4EE"/g)).toBe(b.rows.filter((r) => r.fill === 'EAF4EE').reduce((n, r) => n + r.cells.length, 0));
    });
    // corpo das tabelas em 6,5 pt
    expect(tables[0].split('</w:tr>')[1]).toMatch(/<w:sz w:val="13"\/>/);
  });

  it('marcadores, parágrafo depois de cada tabela e rodapé', async () => {
    const { doc, footer } = await xmlOf();
    expect(doc).toMatch(/<w:ind w:left="227"\/>[\s\S]{0,300}• Um login ativo por pessoa/);
    expect(count(doc, /<\/w:tbl><w:p\/>/g)).toBe(count(doc, /<\/w:tbl>/g));
    expect(footer).toMatch(/<w:jc w:val="center"\/>/);
    expect(footer).toMatch(/CESS — Modelo de Dados/);
  });

  it('sem listas numeradas nem campos (só recursos que a referência usa)', async () => {
    const { doc } = await xmlOf();
    expect(doc).not.toMatch(/<w:numPr>/);
    expect(doc).not.toMatch(/<w:fldChar/);
  });

  it('determinístico: mesma entrada, mesmos bytes; datas de publishedAt', async () => {
    const a = await xmlOf();
    const b = await xmlOf();
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.core).toMatch(/<dcterms:created[^>]*>2026-10-20T12:00:00Z<\/dcterms:created>/);
    expect(a.core).toMatch(/<dcterms:modified[^>]*>2026-10-20T12:00:00Z<\/dcterms:modified>/);
  });

  it('contentHash ignora versão e data e muda com o conteúdo', async () => {
    const p = await cessProject();
    const h = await contentHash(p, 'CESS');
    expect(await contentHash(p, 'CESS')).toBe(h);
    p.doc!.intro = 'outra';
    expect(await contentHash(p, 'CESS')).not.toBe(h);
  });

  it.skipIf(!existsSync('/usr/bin/soffice'))('abre no LibreOffice (conversão para PDF)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-'));
    try {
      const { bytes } = await buildDataDictionary(await cessProject(), meta);
      writeFileSync(join(dir, 'cess.docx'), bytes);
      execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, 'cess.docx')], { timeout: 60_000, stdio: 'ignore' });
      const pdf = readFileSync(join(dir, 'cess.pdf'));
      const pages = count(pdf.toString('latin1'), /\/Type\s*\/Page[^s]/g);
      // capa + convenções + índice + 3 módulos + outras + 2 apêndices
      expect(pages).toBeGreaterThanOrEqual(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('propriedades', () => {
  const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
  const schemaArb = fc.uniqueArray(fc.record({ name: ident, cols: fc.uniqueArray(ident, { minLength: 1, maxLength: 5 }), tag: fc.option(fc.constantFrom('Módulo A — X', 'modulo b', 'Módulo 10: Y', 'core')) }), {
    minLength: 1,
    maxLength: 6,
    selector: (t) => t.name,
  });

  it('toda tabela e toda coluna aparecem exatamente uma vez', async () => {
    await fc.assert(
      fc.asyncProperty(schemaArb, async (defs) => {
        const sql = defs
          .map((d) => `CREATE TABLE t_${d.name} (pk_id int PRIMARY KEY, ${d.cols.map((c) => `c_${c} text`).join(', ')});${d.tag ? `\n-- @erd:tags t_${d.name} ${JSON.stringify(d.tag)}` : ''}`)
          .join('\n');
        const p = await fromSql(sql);
        const { blocks } = buildOutline(p, meta).outline;
        const h2 = blocks.filter((b) => b.kind === 'heading' && b.level === 2).map((b) => (b as { text: string }).text);
        expect(h2.sort()).toEqual(p.schema.tables.map((t) => t.name).sort());
        const fieldRows = blocks.filter((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table' && b.variant === 'fields').flatMap((t) => t.rows);
        expect(fieldRows).toHaveLength(p.schema.tables.reduce((n, t) => n + t.columns.length, 0));
      }),
      { numRuns: 40 },
    );
  });

  it('mesma entrada gera os mesmos bytes', async () => {
    await fc.assert(
      fc.asyncProperty(schemaArb, async (defs) => {
        const p = await fromSql(defs.map((d) => `CREATE TABLE t_${d.name} (pk_id int PRIMARY KEY, ${d.cols.map((c) => `c_${c} text`).join(', ')});`).join('\n'));
        const a = await buildDataDictionary(p, meta);
        const b = await buildDataDictionary(p, meta);
        expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      }),
      { numRuns: 8 },
    );
  });
});
