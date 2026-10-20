import { describe, expect, it } from 'vitest';
import { buildOutline, computeModules, splitModuleTag, markdownToBlocks, type Block } from '../src';
import { cessProject, fromSql } from './helpers';

const meta = { projectName: 'CESS', version: 3, publishedAt: new Date('2026-10-20T12:00:00Z') };
const tables = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table');
const rowOf = (blocks: Block[], tableName: string, col: string) => {
  const i = blocks.findIndex((b) => b.kind === 'heading' && b.level === 2 && b.text === tableName);
  const t = blocks.slice(i).find((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table' && b.variant === 'fields')!;
  return t.rows.find((r) => r.cells[0] === col)!;
};
const relsOf = (blocks: Block[], tableName: string) => {
  const i = blocks.findIndex((b) => b.kind === 'heading' && b.level === 2 && b.text === tableName);
  const next = blocks.slice(i + 1).findIndex((b) => b.kind === 'heading' && b.level !== 3);
  return tables(blocks.slice(i, next < 0 ? undefined : i + 1 + next)).find((t) => t.variant === 'relationships');
};

describe('tags de módulo', () => {
  it('separa módulo e responsabilidade', () => {
    expect(splitModuleTag('Módulo A — Cadastro e Pessoas')).toEqual({ module: 'Módulo A', responsibility: 'Cadastro e Pessoas' });
    expect(splitModuleTag('Módulo B - Projetos')).toEqual({ module: 'Módulo B', responsibility: 'Projetos' });
    expect(splitModuleTag('Módulo C: Auditoria')).toEqual({ module: 'Módulo C', responsibility: 'Auditoria' });
    expect(splitModuleTag('Módulo Financeiro')).toEqual({ module: 'Módulo Financeiro', responsibility: null });
  });

  it('ordem natural, acento e maiúsculas, conflito, nota de descrição e "Outras tabelas"', async () => {
    const p = await fromSql(`CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY); CREATE TABLE c (id int PRIMARY KEY); CREATE TABLE d (id int PRIMARY KEY);
-- @erd:tags a "Módulo 10 — Dez"
-- @erd:tags b "Modulo 2 — Dois", "Módulo 10 — Dez"
-- @erd:tags c "MÓDULO 2 — DOIS"`);
    p.notes = [{ id: 'n', title: 'módulo 2 — dois', content: '# Título\n\nTexto *com* ênfase\n- item [link](http://x)' }];
    const m = computeModules(p);
    expect(m.modules.map((x) => x.module)).toEqual(['Modulo 2', 'Módulo 10']);
    expect(m.modules[0].spellings).toHaveLength(2);
    expect(m.modules[0].tables.map((t) => t.name)).toEqual(['b', 'c']);
    expect(m.conflicts).toEqual([{ tableId: expect.any(String), tableName: 'b', modules: ['Modulo 2 — Dois', 'Módulo 10 — Dez'], chosen: 'Modulo 2 — Dois' }]);
    expect(m.modules[0].note?.id).toBe('n');
    expect(m.others.map((t) => t.name)).toEqual(['d']);
  });

  it('markdown vira parágrafos e marcadores', () => {
    expect(markdownToBlocks('# Título\n\nTexto *com* **ênfase**\ncontinua\n- item [link](http://x)\n1. outro')).toEqual([
      { kind: 'paragraph', text: 'Título' },
      { kind: 'paragraph', text: 'Texto com ênfase continua' },
      { kind: 'bullet', text: 'item link' },
      { kind: 'bullet', text: 'outro' },
    ]);
  });
});

describe('tabela de campos (§1.3)', () => {
  it('tipos, NULL, PK, FK, Unique, Default, Índices/regras e fundo de enum', async () => {
    const { blocks } = buildOutline(await cessProject(), meta).outline;
    expect(rowOf(blocks, 'Person', 'id').cells).toEqual(['id', '—', 'BigInt', 'Não', 'Sim', '—', 'PK', 'autoincrement', 'PK; índice implícito.']);
    expect(rowOf(blocks, 'Person', 'uuid').cells.slice(2)).toEqual(['UUID', 'Não', 'Não', '—', 'Sim', 'uuid()', '—']);
    expect(rowOf(blocks, 'Person', 'fullName').cells.slice(1, 3)).toEqual(['Nome completo', 'VarChar(200)']);
    expect(rowOf(blocks, 'Person', 'document').cells.slice(6)).toEqual(['Sim', '—', 'UNIQUE quando informado']);
    const status = rowOf(blocks, 'Person', 'status');
    expect(status.cells.slice(2)).toEqual(['Status', 'Não', 'Não', '—', 'Não', 'ACTIVE', 'ACTIVE | INACTIVE | BLOCKED']);
    expect(status.fill).toBe('EAF4EE');
    expect(rowOf(blocks, 'Person', 'created_at').cells.slice(2, 3).concat(rowOf(blocks, 'Person', 'created_at').cells[7])).toEqual(['Timestamptz', 'now()']);
    expect(rowOf(blocks, 'Person', 'id').fill).toBeUndefined();

    const login = rowOf(blocks, 'User', 'loginId');
    expect(login.cells[6]).toBe('Parcial');
    expect(login.cells[8]).toBe('UNIQUE(loginId) WHERE status = ACTIVE');
    expect(rowOf(blocks, 'User', 'personId').cells.slice(5)).toEqual(['Person.id', 'Sim', '—', 'ON DELETE CASCADE']);
    expect(rowOf(blocks, 'User', 'preferences').cells.slice(2, 3).concat(rowOf(blocks, 'User', 'preferences').cells[7])).toEqual(['JsonB', '{}']);

    const client = rowOf(blocks, 'Project', 'clientId');
    expect(client.cells.slice(3)).toEqual(['Sim', 'Não', 'User.id', 'Não', 'NULL', 'ON DELETE SET NULL']);
    expect(rowOf(blocks, 'Project', 'startsOn').cells[2]).toBe('Date');
    expect(rowOf(blocks, 'Project', 'budget').cells[2]).toBe('Decimal(12,2)');
    expect(rowOf(blocks, 'Project', 'ownerId').cells[8]).toBe('INDEX(ownerId); ON DELETE RESTRICT');
    expect(rowOf(blocks, 'ProjectMember', 'projectId').cells.slice(4, 7)).toEqual(['Sim', 'Project.id', 'Composto']);
    expect(rowOf(blocks, 'ProjectMember', 'memberFunction').fill).toBe('EAF4EE');
  });

  it('tipos do Postgres quando pedido no formulário', async () => {
    const p = await cessProject();
    p.doc!.typeStyle = 'sql';
    const { blocks } = buildOutline(p, meta).outline;
    expect(rowOf(blocks, 'Person', 'fullName').cells[2]).toBe('varchar(200)');
    expect(rowOf(blocks, 'Person', 'id').cells[2]).toBe('bigserial');
  });
});

describe('relacionamentos (§1.3)', () => {
  it('saída, entrada, rótulo para a mesma tabela, relação-nota e N:N via pivot', async () => {
    const { blocks } = buildOutline(await cessProject(), meta).outline;
    const project = relsOf(blocks, 'Project')!;
    expect(project.rows.map((r) => r.cells)).toEqual([
      ['Project → User (client)', 'N : 0..1', 'Project.clientId → User.id', 'SET NULL', 'cliente do projeto'],
      ['Project → User (owner)', 'N : 1', 'Project.ownerId → User.id', 'RESTRICT', 'responsável'],
      ['Project → ProjectMember', '1 : N', 'ProjectMember.projectId → Project.id', 'CASCADE', '—'],
      ['Project → AuditLog (lógico)', '1 : N', 'AuditLog.entity → Project.title', 'Aplicação', '—'],
      ['Project → User (via ProjectMember)', 'N : N', 'via ProjectMember', 'CASCADE', '—'],
    ]);
    expect(relsOf(blocks, 'AuditLog')!.rows.find((r) => r.cells[0].endsWith('(lógico)'))!.cells).toEqual(['AuditLog → Project (lógico)', 'N : 1', 'AuditLog.entity → Project.title', 'Aplicação', 'registra']);
    const user = relsOf(blocks, 'User')!;
    expect(user.rows[0].cells.slice(0, 2)).toEqual(['User → Person', '1 : 1']);
    expect(user.rows.find((r) => r.cells[0] === 'User → Project (client)')!.cells.slice(1, 2).concat(user.rows.find((r) => r.cells[0] === 'User → Project (client)')!.cells[4])).toEqual(['0..1 : N', 'projetos em que é cliente']);
  });
});

describe('convenções e pendências', () => {
  it('detecta PK, uuid, auditoria, status e exceções', async () => {
    const { review } = buildOutline(await cessProject(), meta);
    const byKey = Object.fromEntries(review.conventions.map((c) => [c.key, c]));
    expect(byKey.pk.pattern).toBe('id BigInt (autoincrement)');
    expect(byKey.pk.goal).toMatch(/Identidade/);
    expect(byKey.uuid).toBeTruthy();
    expect(byKey.audit.pattern).toBe('created_at, updated_at');
    expect(byKey.status.pattern).toBe('status Status (ACTIVE | INACTIVE | BLOCKED)');
    const exceptions = review.conventions.filter((c) => c.key.startsWith('exception:')).map((c) => c.name);
    expect(exceptions).toEqual(['Exceção ProjectMember', 'Exceção Setting']);
    expect(review.pending.some((x) => x.kind === 'convention-goal' && x.conventionKey === 'status')).toBe(true);
    expect(review.pending.filter((x) => x.kind === 'table-description').map((x) => x.label)).toContain('Descrição de Project');
    expect(review.pending.some((x) => x.kind === 'relationship-function' && x.label.includes('Project → User (client)'))).toBe(false);
  });

  it('revisão: módulos, outras tabelas, contagens, nome do arquivo', async () => {
    const { review, outline } = buildOutline(await cessProject(), meta);
    expect(review.modules.map((m) => [m.module, m.responsibility, m.tables.map((t) => t.name), m.note])).toEqual([
      ['Módulo A', 'Cadastro e Pessoas', ['Person', 'User'], 'Módulo A — Cadastro e Pessoas'],
      ['Módulo B', 'Projetos', ['Project', 'ProjectMember'], null],
      ['Módulo C', 'Auditoria', ['AuditLog'], null],
    ]);
    expect(review.otherTables.map((t) => t.name)).toEqual(['Setting']);
    expect(review.counts).toEqual({ tables: 6, columns: 37, relationships: 7, enums: 4 });
    expect(review.fileName).toBe('Modelo_Dados_cess.docx');
    expect(outline.footer).toBe('CESS — Modelo de Dados');
    const h1 = outline.blocks.filter((b) => b.kind === 'heading' && b.level === 1).map((b) => (b as { text: string }).text);
    expect(h1).toEqual([
      '1. Convenções de modelagem',
      '2. Índice de módulos',
      'Módulo A — Cadastro e Pessoas',
      'Módulo B — Projetos',
      'Módulo C — Auditoria',
      'Outras tabelas',
      'Apêndice A — Resumo das restrições UNIQUE',
      'Apêndice B — Resumo dos índices recomendados',
    ]);
    const cover = outline.blocks[0] as Extract<Block, { kind: 'cover' }>;
    expect(cover.edition).toBe('CESS — versão 3');
  });

  it('marcadores: índice parcial, CHECK e regras do formulário', async () => {
    const { blocks } = buildOutline(await cessProject(), meta).outline;
    const bullets = blocks.filter((b) => b.kind === 'bullet').map((b) => (b as { text: string }).text);
    expect(bullets).toContain('Aplicar índice único parcial: UNIQUE(loginId) WHERE status = ACTIVE');
    expect(bullets).toContain('Validar project_budget_positive: CHECK (budget >= 0)');
    expect(bullets).toContain('Um login ativo por pessoa');
    expect(bullets).toContain('Pessoa é a entidade raiz');
  });

  it('apêndices', async () => {
    const { blocks } = buildOutline(await cessProject(), meta).outline;
    const app = tables(blocks).filter((t) => t.variant === 'appendix');
    expect(app[0].rows.find((r) => r.cells[0] === 'User')!.cells[1]).toBe('UNIQUE(uuid); UNIQUE(personId); UNIQUE(loginId) WHERE status = ACTIVE (via índice parcial)');
    expect(app[1].rows.map((r) => r.cells)).toEqual([
      ['Project', 'INDEX(ownerId)'],
      ['AuditLog', 'INDEX(entity, created_at)'],
    ]);
  });
});
