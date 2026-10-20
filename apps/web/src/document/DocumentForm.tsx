import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Draft } from 'immer';
import type { DocContent, Id, Table } from '@erd/model/types';
import { emptyDocContent, normalizeDocContent, orphanDocEntries } from '@erd/model/docContent';
import { computeModules, detectConventions, relationshipRows, type DocReview } from '@erd/docx';
import { fileNameFor } from '@erd/docx/outline';
import { useProjectStore, type Doc } from '../store/useProjectStore';
import { CommitInput } from '../canvas/Inspector';
import { docProjectName } from './client';
import { useDocUi } from './useDocUi';

/** Escreve no formulário (raiz `doc` do Y.Doc) como uma edição comum: colaborativa e desfazível */
export function updateDoc(fn: (c: Draft<DocContent>, d: Draft<Doc>) => void) {
  useProjectStore.getState().commit((d) => {
    if (!d.doc) d.doc = emptyDocContent();
    fn(d.doc as Draft<DocContent>, d);
  }, 'inspector');
}

function Block({ title, children, sub }: { title: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
      <h3 className="mb-2 flex items-baseline gap-2 text-[12.5px] font-semibold text-slate-800">
        {title}
        {sub && <span className="text-[11px] font-normal text-slate-500">{sub}</span>}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, hint, missing, children }: { label: string; hint?: string; missing?: boolean; children: ReactNode }) {
  return (
    <label className="mb-2 block text-[10.5px] text-slate-500">
      <span className="flex items-center gap-1.5">
        {label}
        {missing && <span className="rounded bg-amber-100 px-1 text-[9.5px] font-medium text-amber-700">pendente</span>}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-slate-400">{hint}</span>}
    </label>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

function TableSection({ table, module, content, readOnly, onlyMissing }: { table: Table; module: string; content: DocContent; readOnly: boolean; onlyMissing: boolean }) {
  const doc = useProjectStore((s) => s.doc);
  const rels = useMemo(() => relationshipRows({ schema: doc.schema, meta: doc.meta } as never, table, content), [doc.schema, doc.meta, table, content]);
  const rules = content.tables[table.id]?.rules ?? [];
  const missingDesc = !table.comment?.trim();
  const missingCols = table.columns.filter((c) => !c.comment?.trim());
  const missingRels = rels.filter((r) => !r.hasFunction);
  if (onlyMissing && !missingDesc && !missingCols.length && !missingRels.length) return null;
  const upd = (recipe: (t: Draft<Table>) => void) =>
    updateDoc((_c, d) => {
      const t = d.schema.tables.find((x) => x.id === table.id);
      if (t) recipe(t);
    });
  return (
    <div id={`doc-table-${table.id}`} className="mb-3 rounded-md border border-slate-200 p-2.5" data-testid="doc-table">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12.5px] font-semibold text-emerald-800">{table.name}</span>
        <span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">{module}</span>
      </div>
      {(!onlyMissing || missingDesc) && (
        <Field label="Descrição da tabela" hint="É o comentário da tabela: vai para o SQL como COMMENT ON TABLE." missing={missingDesc}>
          {readOnly ? (
            <p className="text-[12px] text-slate-700">{table.comment || '—'}</p>
          ) : (
            <CommitInput multiline value={table.comment ?? ''} onCommit={(v) => upd((t) => void (t.comment = v.trim() || undefined))} />
          )}
        </Field>
      )}
      {!onlyMissing && (
        <Field label="Regras de negócio" hint="Uma por linha. Viram marcadores (•) abaixo da descrição.">
          {readOnly ? (
            <p className="whitespace-pre-wrap text-[12px] text-slate-700">{rules.join('\n') || '—'}</p>
          ) : (
            <CommitInput
              multiline
              value={rules.join('\n')}
              onCommit={(v) =>
                updateDoc((c) => {
                  const r = lines(v);
                  if (r.length) c.tables[table.id] = { rules: r };
                  else delete c.tables[table.id];
                })
              }
            />
          )}
        </Field>
      )}
      {(!onlyMissing || missingCols.length > 0) && (
        <div className="mb-2">
          <div className="mb-1 text-[10.5px] text-slate-500">Descrição das colunas</div>
          <div className="grid grid-cols-[minmax(90px,max-content)_1fr] items-center gap-x-2 gap-y-1">
            {(onlyMissing ? missingCols : table.columns).map((col) => (
              <div key={col.id} className="contents">
                <span className="truncate font-mono text-[11px] text-slate-700" title={col.name}>
                  {col.name}
                </span>
                {readOnly ? (
                  <span className="text-[12px] text-slate-700">{col.comment || '—'}</span>
                ) : (
                  <CommitInput
                    value={col.comment ?? ''}
                    placeholder="—"
                    onCommit={(v) =>
                      upd((t) => {
                        const c = t.columns.find((x) => x.id === col.id);
                        if (c) c.comment = v.trim() || undefined;
                      })
                    }
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {rels.length > 0 && (!onlyMissing || missingRels.length > 0) && (
        <div>
          <div className="mb-1 text-[10.5px] text-slate-500">Função das relações (vista desta tabela)</div>
          <div className="grid grid-cols-[minmax(120px,max-content)_1fr] items-center gap-x-2 gap-y-1">
            {(onlyMissing ? missingRels : rels).map((r) => {
              const cur = content.relationships[r.key];
              const value = (r.side === 'from' ? cur?.fromSide : cur?.toSide) ?? '';
              return (
                <div key={r.key + r.side} className="contents">
                  <span className="truncate text-[11px] text-slate-700" title={`${r.cells[0]} · ${r.cells[1]}`}>
                    {r.cells[0]} <span className="text-slate-400">{r.cells[1]}</span>
                  </span>
                  {readOnly ? (
                    <span className="text-[12px] text-slate-700">{value || r.cells[4]}</span>
                  ) : (
                    <CommitInput
                      value={value}
                      placeholder={r.cells[4] !== '—' ? r.cells[4] : 'ex.: cliente do projeto'}
                      onCommit={(v) =>
                        updateDoc((c) => {
                          const e = { ...(c.relationships[r.key] ?? {}) };
                          if (r.side === 'from') e.fromSide = v.trim() || undefined;
                          else e.toSide = v.trim() || undefined;
                          if (!e.fromSide) delete e.fromSide;
                          if (!e.toSide) delete e.toSide;
                          if (e.fromSide || e.toSide) c.relationships[r.key] = e;
                          else delete c.relationships[r.key];
                        })
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * O formulário do documento (§1.4): só o que o modelo não tem. Módulos não ficam aqui (vêm
 * das tags); descrições de tabela e coluna gravam no próprio modelo (COMMENT ON).
 */
export function DocumentForm({ readOnly, review }: { readOnly: boolean; review: DocReview | null }) {
  const doc = useProjectStore((s) => s.doc);
  const onlyMissing = useDocUi((s) => s.onlyMissing);
  const focusTable = useDocUi((s) => s.focusTable);
  const set = useDocUi((s) => s.set);
  const content = useMemo(() => normalizeDocContent(doc.doc), [doc.doc]);
  const mods = useMemo(() => computeModules(doc as never), [doc]);
  const conventions = useMemo(() => detectConventions(doc.schema, content), [doc.schema, content]);
  const orphans = useMemo(() => {
    const tableIds = new Set(doc.schema.tables.map((t) => t.id));
    const relIds = new Set([...doc.schema.relationships.map((r) => r.id), ...doc.schema.tables.map((t) => `pivot:${t.id}`)]);
    return orphanDocEntries(content, tableIds, relIds);
  }, [doc.schema, content]);
  const scrolled = useRef<Id | null>(null);
  useEffect(() => {
    if (!focusTable || scrolled.current === focusTable) return;
    scrolled.current = focusTable;
    document.getElementById(`doc-table-${focusTable}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusTable]);

  const c = content.cover;
  const coverField = (k: keyof DocContent['cover']) => (v: string) => updateDoc((d) => void (d.cover[k] = v.trim()));
  const sections = [...mods.modules.map((m) => ({ title: m.title, tables: m.tables })), ...(mods.others.length ? [{ title: 'Outras tabelas', tables: mods.others }] : [])];
  const pendingCount = review?.pending.length;

  return (
    <fieldset disabled={readOnly} className="min-w-0 text-[12px]" data-testid="doc-form">
      <div className="mb-3 flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
          <input type="checkbox" className="accent-indigo-600" checked={onlyMissing} onChange={(e) => set({ onlyMissing: e.target.checked })} />
          Só o que falta
        </label>
        {pendingCount !== undefined && (
          <span className={'rounded-full px-2 py-0.5 text-[11px] ' + (pendingCount ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')} data-testid="doc-pending">
            {pendingCount ? `${pendingCount} pendência(s)` : 'Nada pendente'}
          </span>
        )}
        {readOnly && <span className="text-[11px] text-slate-500">Somente leitura</span>}
      </div>

      {(!onlyMissing || !c.title || !c.scope) && (
        <Block title="Capa">
          <Field label="Título" missing={!c.title}>
            <CommitInput value={c.title} placeholder="Modelo de Dados" onCommit={coverField('title')} />
          </Field>
          {!onlyMissing && (
            <>
              <Field label="Subtítulo" hint="Vazio = o nome do projeto">
                <CommitInput value={c.subtitle} placeholder={docProjectName()} onCommit={coverField('subtitle')} />
              </Field>
              <Field label="Linha 3" hint="Aceita {projeto}, {versao} e {data}">
                <CommitInput value={c.edition} placeholder="{projeto} — versão {versao}" onCommit={coverField('edition')} />
              </Field>
            </>
          )}
          <Field label="Escopo" missing={!c.scope}>
            <CommitInput multiline value={c.scope} onCommit={coverField('scope')} />
          </Field>
        </Block>
      )}

      {!onlyMissing && (
        <Block title="Arquivo e tipos">
          <Field label="Nome do arquivo">
            <CommitInput
              value={content.fileName}
              placeholder={fileNameFor({ ...content, fileName: '' }, docProjectName())}
              onCommit={(v) => updateDoc((d) => void (d.fileName = v.trim()))}
            />
          </Field>
          <div className="flex gap-4 text-[12px] text-slate-700">
            {(['prisma', 'sql'] as const).map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="typeStyle"
                  disabled={readOnly}
                  checked={content.typeStyle === s}
                  onChange={() => updateDoc((d) => void (d.typeStyle = s))}
                  className="accent-indigo-600"
                />
                {s === 'prisma' ? 'Tipos no estilo Prisma (VarChar, BigInt…)' : 'Tipos do Postgres (varchar, bigint…)'}
              </label>
            ))}
          </div>
        </Block>
      )}

      <Block title="1. Convenções de modelagem" sub="as linhas vêm do modelo; complete o objetivo">
        {(!onlyMissing || !content.intro) && (
          <Field label="Introdução" missing={!content.intro}>
            <CommitInput multiline value={content.intro} onCommit={(v) => updateDoc((d) => void (d.intro = v.trim()))} />
          </Field>
        )}
        <div className="space-y-1.5">
          {conventions
            .filter((cv) => cv.detected && (!onlyMissing || !cv.goal))
            .map((cv) => (
              <div key={cv.key} className="rounded border border-slate-100 bg-slate-50 p-1.5" data-testid="doc-convention">
                <div className="text-[11.5px] text-slate-700">
                  <b>{cv.name}</b> · <span className="font-mono text-[11px]">{cv.pattern}</span>
                </div>
                <CommitInput
                  value={cv.goal}
                  placeholder="Objetivo"
                  onCommit={(v) =>
                    updateDoc((d) => {
                      if (v.trim()) d.conventions.detected[cv.key] = { goal: v.trim() };
                      else delete d.conventions.detected[cv.key];
                    })
                  }
                />
              </div>
            ))}
        </div>
        {!onlyMissing && (
          <div className="mt-2">
            <div className="mb-1 text-[10.5px] text-slate-500">Convenções acrescentadas</div>
            {content.conventions.extra.map((x, i) => (
              <div key={i} className="mb-1 grid grid-cols-[1fr_1fr_1.4fr_auto] gap-1">
                <CommitInput value={x.name} placeholder="Convenção" onCommit={(v) => updateDoc((d) => void (d.conventions.extra[i].name = v.trim()))} />
                <CommitInput value={x.pattern} placeholder="Padrão" onCommit={(v) => updateDoc((d) => void (d.conventions.extra[i].pattern = v.trim()))} />
                <CommitInput value={x.goal} placeholder="Objetivo" onCommit={(v) => updateDoc((d) => void (d.conventions.extra[i].goal = v.trim()))} />
                {!readOnly && (
                  <button
                    title="Remover"
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={() => updateDoc((d) => void d.conventions.extra.splice(i, 1))}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {!readOnly && (
              <button
                className="mt-1 flex items-center gap-1 rounded border border-dashed border-slate-300 px-2 py-1 text-[11.5px] text-slate-600 hover:bg-slate-50"
                onClick={() => updateDoc((d) => void d.conventions.extra.push({ name: 'Nova convenção', pattern: '', goal: '' }))}
              >
                <Plus size={12} /> Acrescentar convenção
              </button>
            )}
          </div>
        )}
      </Block>

      <Block title="Tabelas" sub="na ordem do documento; módulos vêm das tags que começam com “Módulo”">
        {sections.map((s) => s.tables.map((t) => <TableSection key={t.id} table={t} module={s.title} content={content} readOnly={readOnly} onlyMissing={onlyMissing} />))}
        {!doc.schema.tables.length && <p className="text-[12px] text-slate-500">Nenhuma tabela no canvas ainda.</p>}
      </Block>

      {(orphans.tables.length > 0 || orphans.relationships.length > 0) && (
        <Block title="Sobras do formulário" sub="tabelas ou relações que não existem mais">
          <p className="mb-2 text-[11.5px] text-slate-600">
            {orphans.tables.length} regra(s) de tabela e {orphans.relationships.length} função(ões) de relação ficaram sem dono.
          </p>
          {!readOnly && (
            <button
              className="rounded border border-slate-300 px-2 py-1 text-[11.5px] text-slate-700 hover:bg-slate-50"
              onClick={() =>
                updateDoc((d) => {
                  for (const id of orphans.tables) delete d.tables[id];
                  for (const id of orphans.relationships) delete d.relationships[id];
                })
              }
            >
              Descartar
            </button>
          )}
        </Block>
      )}
    </fieldset>
  );
}
