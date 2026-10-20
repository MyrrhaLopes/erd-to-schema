/**
 * Especificação visual do documento de referência (drive-docx-plan §1.1), medida no XML de
 * `Modelo_Dados_CESS_Revisado.docx`. Unidades do Word: twips (1/20 pt), tamanhos de fonte
 * em meios pontos (`sz`), cores sem `#`.
 */
export const THEME = {
  font: 'Arial',
  page: { width: 16838, height: 11906, margin: { top: 794, bottom: 794, left: 680, right: 680 } },
  /** Arial 9 pt, 10 pt depois, entrelinha 1,15 */
  body: { size: 18, after: 200, line: 276 },
  cover: {
    title: { size: 52, color: '0B5731', before: 1000 },
    subtitle: { size: 32, color: '0F6F3D' },
    edition: { size: 22 },
    scope: { size: 20 },
  },
  heading1: { size: 34, color: '0B5731', before: 480 },
  heading2: { size: 26, color: '0F6F3D' },
  heading3: { size: 22, color: '16834A' },
  description: { size: 18, after: 80 },
  bullet: { size: 17, after: 40, indent: 227, prefix: '• ' },
  table: {
    width: 15477,
    border: { size: 4, color: '000000' },
    header: { size: 15, color: 'FFFFFF' },
    body: { size: 13, color: '000000' },
    /** Fundo do cabeçalho por tipo de tabela */
    fill: { main: '0B5731', relationships: '16834A' },
    /** Linhas de colunas do tipo enum */
    enumRow: 'EAF4EE',
  },
  footer: { size: 18 },
} as const;

export type TableVariant = 'fields' | 'conventions' | 'modules' | 'relationships' | 'appendix';

export const headerFill = (v: TableVariant) => (v === 'relationships' ? THEME.table.fill.relationships : THEME.table.fill.main);
