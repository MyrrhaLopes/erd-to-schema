import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Code2, Download, Plus, Table2, Trash2, X } from 'lucide-react';
import type { Cardinality, Id, RefAction, Table } from '@erd/model/types';
import { REF_ACTIONS } from '@erd/model/types';
import { formatType, parseTypeString } from '@erd/model/columnType';
import { newId } from '@erd/model/naming';
import { columnById, relCardinality, tableById } from '@erd/model/schema';
import { allTags, autoTags, effectiveTags } from '@erd/model/tags';
import { isModuleTag } from '@erd/docx/modules';
import { useProjectStore } from '../store/useProjectStore';
import { useUi, revealTableInCode } from '../store/useUi';
import {
  addColumn,
  convertNoteToPivot,
  deleteElements,
  moveColumn,
  removeColumn,
  setTags,
  updateNote,
  updateRelationship,
  updateTable,
} from '../store/actions';
import { downloadNote } from '../persistence/notes';
import { NOTE_COLORS } from './nodes/NoteNode';

/** Input que só comita no blur/Enter (uma entrada de undo por edição, não por tecla) */
function CommitInput({
  value,
  onCommit,
  placeholder,
  className,
  list,
  multiline,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  list?: string;
  multiline?: boolean;
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  const props = {
    value: v,
    placeholder,
    onFocus: () => (focused.current = true),
    onChange: (e: { target: { value: string } }) => setV(e.target.value),
    onBlur: () => {
      focused.current = false;
      if (v !== value) onCommit(v);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !multiline) (e.target as HTMLElement).blur();
      if (e.key === 'Escape') {
        setV(value);
        setTimeout(() => (e.target as HTMLElement).blur());
      }
    },
    className: 'w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] outline-none focus:border-indigo-400 ' + (className ?? ''),
  };
  return multiline ? <textarea rows={3} {...props} /> : <input list={list} {...props} />;
}

function Section({ title, children, defaultOpen = true, extra }: { title: string; children: ReactNode; defaultOpen?: boolean; extra?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-slate-100 py-2">
      <div className="flex items-center gap-1">
        <button className="flex flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </button>
        {extra}
      </div>
      {open && <div className="mt-1.5 space-y-1.5">{children}</div>}
    </div>
  );
}

const Toggle = ({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title: string }) => (
  <button
    title={title}
    onClick={onClick}
    className={'h-6 rounded px-1 text-[9.5px] font-bold ' + (on ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400 hover:text-slate-600')}
  >
    {label}
  </button>
);

const IconBtn = ({ onClick, title, children, danger }: { onClick: () => void; title: string; children: ReactNode; danger?: boolean }) => (
  <button title={title} onClick={onClick} className={'rounded p-1 ' + (danger ? 'text-slate-400 hover:bg-red-50 hover:text-red-600' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700')}>
    {children}
  </button>
);

function TagEditor({ id }: { id: Id }) {
  const doc = useProjectStore((s) => s.doc);
  const view = useProjectStore((s) => s.view);
  const project = { version: 1 as const, name: '', view, ...doc };
  const auto = autoTags(project, id);
  const manual = doc.meta[id]?.tags ?? [];
  const suppressed = doc.meta[id]?.suppressedTags ?? [];
  const eff = effectiveTags(project, id);
  const [draft, setDraft] = useState('');
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {eff.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">
            {t}
            {auto.includes(t) && !manual.includes(t) && <span className="text-[9px] text-violet-400">auto</span>}
            <button
              title={auto.includes(t) && !manual.includes(t) ? 'Remover tag automática (override manual)' : 'Remover tag'}
              onClick={() =>
                setTags(
                  id,
                  manual.filter((x) => x !== t),
                  auto.includes(t) ? [...new Set([...suppressed, t])] : suppressed,
                )
              }
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {suppressed.map((t) => (
          <button
            key={t}
            title="Tag automática removida — clique para restaurar"
            className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400 line-through"
            onClick={() => setTags(id, manual, suppressed.filter((x) => x !== t))}
          >
            {t}
          </button>
        ))}
      </div>
      <form
        className="mt-1.5 flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          // tags de módulo ("Módulo A — Cadastro") ficam como foram escritas: viram título no documento Word
          const raw = draft.trim().replace(/\s+/g, ' ');
          const t = isModuleTag(raw) ? raw : raw.toLowerCase().replace(/\s+/g, '-');
          if (t) setTags(id, [...new Set([...manual, t])], suppressed.filter((x) => x !== t));
          setDraft('');
        }}
      >
        <input
          value={draft}
          list="erd-module-tags"
          onChange={(e) => setDraft(e.target.value)}
          placeholder="nova tag (ex.: core, Módulo A — Cadastro)"
          className="w-full rounded border border-slate-200 px-1.5 py-1 text-[12px] outline-none focus:border-indigo-400"
        />
        <datalist id="erd-module-tags">
          {allTags(project)
            .filter(isModuleTag)
            .map((t) => (
              <option key={t} value={t} />
            ))}
        </datalist>
        <button className="rounded bg-slate-100 px-2 text-[11px] text-slate-600 hover:bg-slate-200">+</button>
      </form>
    </div>
  );
}

function ColumnEditor({ table, colId }: { table: Table; colId: Id }) {
  const col = columnById(table, colId)!;
  const [open, setOpen] = useState(false);
  const isPk = table.primaryKey.includes(colId);
  const upd = (fn: (c: Table['columns'][number], t: Table) => void) =>
    updateTable(table.id, (t) => {
      const c = t.columns.find((x) => x.id === colId);
      if (c) fn(c, t as Table);
    });
  return (
    <div className="rounded border border-slate-100 bg-slate-50/60 p-1">
      <div className="flex items-center gap-1">
        <button className="text-slate-400" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <CommitInput value={col.name} onCommit={(v) => v.trim() && upd((c) => void (c.name = v.trim()))} className="min-w-0 flex-[1.2]" />
        <CommitInput value={formatType(col.type)} list="erd-types" onCommit={(v) => v.trim() && upd((c) => void (c.type = parseTypeString(v)))} className="min-w-0 flex-1 font-mono" />
        <Toggle
          on={isPk}
          label="PK"
          title="Chave primária"
          onClick={() =>
            updateTable(table.id, (t) => {
              t.primaryKey = isPk ? t.primaryKey.filter((x) => x !== colId) : [...t.primaryKey, colId];
              const c = t.columns.find((x) => x.id === colId)!;
              if (!isPk) c.nullable = false;
            })
          }
        />
        <Toggle on={!col.nullable} label="NN" title="NOT NULL" onClick={() => upd((c) => void (c.nullable = !c.nullable))} />
        <Toggle on={!!col.unique} label="UQ" title="UNIQUE" onClick={() => upd((c) => void (c.unique = !c.unique || undefined))} />
      </div>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          <label className="block text-[10px] text-slate-500">
            Default (expressão SQL)
            <CommitInput value={col.default ?? ''} placeholder="ex.: now(), 0, 'ativo'" onCommit={(v) => upd((c) => void (c.default = v.trim() || undefined))} className="font-mono" />
          </label>
          <label className="block text-[10px] text-slate-500">
            Identity
            <select
              value={col.identity ?? ''}
              onChange={(e) => upd((c) => void (c.identity = (e.target.value || undefined) as typeof c.identity))}
              className="w-full rounded border border-slate-200 bg-white px-1 py-1 text-[12px]"
            >
              <option value="">—</option>
              <option value="always">GENERATED ALWAYS</option>
              <option value="by-default">GENERATED BY DEFAULT</option>
            </select>
          </label>
          <label className="block text-[10px] text-slate-500">
            Comentário
            <CommitInput value={col.comment ?? ''} onCommit={(v) => upd((c) => void (c.comment = v.trim() || undefined))} />
          </label>
          <div className="flex justify-end gap-1">
            <IconBtn title="Mover para cima" onClick={() => moveColumn(table.id, colId, -1)}>
              <ArrowUp size={13} />
            </IconBtn>
            <IconBtn title="Mover para baixo" onClick={() => moveColumn(table.id, colId, 1)}>
              <ArrowDown size={13} />
            </IconBtn>
            <IconBtn danger title="Remover coluna" onClick={() => removeColumn(table.id, colId)}>
              <Trash2 size={13} />
            </IconBtn>
          </div>
        </div>
      )}
    </div>
  );
}

const CARD_OPTIONS: { value: Cardinality; label: string }[] = [
  { value: '1:1', label: '1:1' },
  { value: '0:1', label: '0:1 (lado único opcional)' },
  { value: '1:N', label: '1:N' },
  { value: '0:N', label: '0:N (lado único opcional)' },
  { value: 'N:1', label: 'N:1' },
  { value: 'N:N', label: 'N:N' },
];

const colsToNames = (t: Table, ids: Id[]) => ids.map((i) => columnById(t, i)?.name ?? '?').join(', ');
const namesToCols = (t: Table, s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .map((n) => t.columns.find((c) => c.name === n)?.id)
    .filter((x): x is Id => !!x);

function TableInspector({ table }: { table: Table }) {
  const schema = useProjectStore((s) => s.doc.schema);
  const rels = schema.relationships.filter((r) => r.fromTable === table.id || r.toTable === table.id);
  return (
    <>
      <div className="space-y-1.5">
        <label className="block text-[10px] text-slate-500">
          Nome
          <CommitInput value={table.name} onCommit={(v) => v.trim() && updateTable(table.id, (t) => void (t.name = v.trim()), 'Tabela renomeada')} className="font-semibold" />
        </label>
        <div className="flex gap-1.5">
          <label className="block flex-1 text-[10px] text-slate-500">
            Schema
            <CommitInput value={table.schema ?? ''} placeholder="public" onCommit={(v) => updateTable(table.id, (t) => void (t.schema = v.trim() && v.trim() !== 'public' ? v.trim() : undefined))} />
          </label>
        </div>
        <label className="block text-[10px] text-slate-500">
          Comentário
          <CommitInput multiline value={table.comment ?? ''} onCommit={(v) => updateTable(table.id, (t) => void (t.comment = v.trim() || undefined))} />
        </label>
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-1.5 text-[11.5px] font-medium text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
          onClick={() => revealTableInCode(table.id)}
        >
          <Code2 size={13} /> Ver em código
        </button>
      </div>
      <Section title="Tags">
        <TagEditor id={table.id} />
      </Section>
      <Section
        title={`Colunas (${table.columns.length})`}
        extra={
          <IconBtn title="Adicionar coluna" onClick={() => addColumn(table.id)}>
            <Plus size={13} />
          </IconBtn>
        }
      >
        {table.columns.map((c) => (
          <ColumnEditor key={c.id} table={table} colId={c.id} />
        ))}
      </Section>
      <Section
        title={`Índices (${table.indexes.length})`}
        defaultOpen={table.indexes.length > 0}
        extra={
          <IconBtn
            title="Adicionar índice"
            onClick={() => updateTable(table.id, (t) => void t.indexes.push({ id: newId('i_'), columns: t.columns.slice(-1).map((c) => c.id), unique: false }))}
          >
            <Plus size={13} />
          </IconBtn>
        }
      >
        {table.indexes.map((ix) => (
          <div key={ix.id} className="space-y-1 rounded border border-slate-100 p-1">
            <div className="flex items-center gap-1">
              <CommitInput
                value={colsToNames(table, ix.columns)}
                placeholder="colunas, separadas, por vírgula"
                onCommit={(v) => updateTable(table.id, (t) => void (t.indexes.find((i) => i.id === ix.id)!.columns = namesToCols(t as Table, v)))}
                className="font-mono"
              />
              <Toggle on={ix.unique} label="UQ" title="Índice único" onClick={() => updateTable(table.id, (t) => void (t.indexes.find((i) => i.id === ix.id)!.unique = !ix.unique))} />
              <IconBtn danger title="Remover índice" onClick={() => updateTable(table.id, (t) => void (t.indexes = t.indexes.filter((i) => i.id !== ix.id)))}>
                <Trash2 size={12} />
              </IconBtn>
            </div>
            <CommitInput
              value={ix.where ?? ''}
              placeholder="WHERE (índice parcial, opcional)"
              onCommit={(v) => updateTable(table.id, (t) => void (t.indexes.find((i) => i.id === ix.id)!.where = v.trim() || undefined))}
              className="font-mono"
            />
          </div>
        ))}
      </Section>
      <Section
        title={`Checks (${table.checks.length})`}
        defaultOpen={table.checks.length > 0}
        extra={
          <IconBtn title="Adicionar CHECK" onClick={() => updateTable(table.id, (t) => void t.checks.push({ id: newId('k_'), expr: 'true' }))}>
            <Plus size={13} />
          </IconBtn>
        }
      >
        {table.checks.map((k) => (
          <div key={k.id} className="flex items-center gap-1">
            <CommitInput value={k.expr} onCommit={(v) => updateTable(table.id, (t) => void (t.checks.find((x) => x.id === k.id)!.expr = v.trim() || 'true'))} className="font-mono" />
            <IconBtn danger title="Remover CHECK" onClick={() => updateTable(table.id, (t) => void (t.checks = t.checks.filter((x) => x.id !== k.id)))}>
              <Trash2 size={12} />
            </IconBtn>
          </div>
        ))}
      </Section>
      <Section title={`Relações (${rels.length})`} defaultOpen={false}>
        {rels.map((r) => {
          const other = tableById(schema, r.fromTable === table.id ? r.toTable : r.fromTable);
          return (
            <div key={r.id} className="flex items-center gap-1 text-[11.5px] text-slate-600">
              <span className={'rounded px-1 text-[9px] font-bold ' + (r.kind === 'fk' ? 'bg-slate-200 text-slate-600' : 'bg-purple-100 text-purple-700')}>{r.kind === 'fk' ? 'FK' : 'NOTA'}</span>
              {r.fromTable === table.id ? '→' : '←'} {other?.name}
              <span className="ml-auto text-slate-400">{r.kind === 'fk' ? relCardinality(schema, r) : r.cardinality ?? ''}</span>
            </div>
          );
        })}
      </Section>
      <div className="border-t border-slate-100 pt-2">
        <button className="flex items-center gap-1 text-[12px] text-red-600 hover:underline" onClick={() => deleteElements({ nodes: [table.id], edges: [] })}>
          <Trash2 size={13} /> Excluir tabela
        </button>
      </div>
    </>
  );
}

function RelationshipInspector({ id }: { id: Id }) {
  const schema = useProjectStore((s) => s.doc.schema);
  const setView = useProjectStore((s) => s.setView);
  if (id.startsWith('nn:')) {
    const pivot = tableById(schema, id.slice(3));
    return (
      <div className="space-y-2 text-[12px] text-slate-600">
        <p>
          Relação <b>N:N</b> via tabela pivot <code className="rounded bg-slate-100 px-1">{pivot?.name}</code> (oculta pelo filtro).
        </p>
        <button className="rounded bg-indigo-50 px-2 py-1 text-indigo-700 hover:bg-indigo-100" onClick={() => setView((v) => void (v.hiddenTags = v.hiddenTags.filter((t) => t !== 'pivot')))}>
          Mostrar tabelas pivot
        </button>
        <button className="flex items-center gap-1 text-red-600 hover:underline" onClick={() => deleteElements({ nodes: [], edges: [id] })}>
          <Trash2 size={13} /> Remover relação N:N (exclui o pivot)
        </button>
      </div>
    );
  }
  const r = schema.relationships.find((x) => x.id === id);
  if (!r) return null;
  const from = tableById(schema, r.fromTable)!;
  const to = tableById(schema, r.toTable)!;
  const endpoint = (t: Table, cols: Id[]) => (
    <code className="rounded bg-slate-100 px-1 text-[11px]">
      {t.name}
      {cols.length ? `(${colsToNames(t, cols)})` : ''}
    </code>
  );
  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-1 text-slate-600">
        {endpoint(from, r.fromColumns)} → {endpoint(to, r.toColumns)}
      </div>
      {r.kind === 'fk' ? (
        <>
          <div className="text-[11px] text-slate-500">
            Cardinalidade: <b>{relCardinality(schema, r)}</b> (derivada: FK única = 1:1)
          </div>
          <label className="block text-[10px] text-slate-500">
            Nome da constraint
            <CommitInput value={r.name ?? ''} placeholder="(automático)" onCommit={(v) => updateRelationship(id, (x) => void (x.name = v.trim() || undefined))} />
          </label>
          {(['onDelete', 'onUpdate'] as const).map((k) => (
            <label key={k} className="block text-[10px] text-slate-500">
              {k === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'}
              <select
                value={r[k] ?? 'no action'}
                onChange={(e) => updateRelationship(id, (x) => void (x[k] = e.target.value as RefAction))}
                className="w-full rounded border border-slate-200 bg-white px-1 py-1 text-[12px]"
              >
                {REF_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            className="rounded bg-purple-50 px-2 py-1 text-purple-700 hover:bg-purple-100"
            onClick={() =>
              updateRelationship(id, (x) => {
                x.kind = 'note';
                x.cardinality = relCardinality(schema, r);
                x.label = 'relação';
              })
            }
          >
            Converter em relação-nota
          </button>
        </>
      ) : (
        <>
          <label className="block text-[10px] text-slate-500">
            Rótulo (A → B)
            <CommitInput value={r.label ?? ''} onCommit={(v) => updateRelationship(id, (x) => void (x.label = v.trim() || undefined))} />
          </label>
          <label className="block text-[10px] text-slate-500">
            Cardinalidade (A → B)
            <select
              value={r.cardinality ?? ''}
              onChange={(e) => updateRelationship(id, (x) => void (x.cardinality = (e.target.value || undefined) as Cardinality))}
              className="w-full rounded border border-slate-200 bg-white px-1 py-1 text-[12px]"
            >
              <option value="">—</option>
              {CARD_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600"
            title="Exibe também o nome da relação no sentido contrário (B → A)"
          >
            <input
              type="checkbox"
              checked={!!r.showReverse}
              onChange={() => updateRelationship(id, (x) => void (x.showReverse = !x.showReverse))}
              className="accent-purple-600"
            />
            Mostrar relação reversa
          </label>
          {r.showReverse && (
            <>
              <label className="block text-[10px] text-slate-500">
                Nome no sentido contrário (B → A)
                <CommitInput
                  value={r.reverseLabel ?? ''}
                  placeholder="ex.: pertence a"
                  onCommit={(v) => updateRelationship(id, (x) => void (x.reverseLabel = v.trim() || undefined))}
                />
              </label>
              <label className="block text-[10px] text-slate-500">
                Cardinalidade reversa (B → A)
                <select
                  value={r.reverseCardinality ?? ''}
                  onChange={(e) => updateRelationship(id, (x) => void (x.reverseCardinality = (e.target.value || undefined) as Cardinality))}
                  className="w-full rounded border border-slate-200 bg-white px-1 py-1 text-[12px]"
                >
                  <option value="">—</option>
                  {CARD_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {r.cardinality === 'N:N' && r.showReverse && r.reverseCardinality === 'N:N' && (
            <div className="mt-1 rounded-lg border border-purple-200 bg-purple-50/70 p-2 text-center">
              <div className="text-[10.5px] font-medium text-purple-900">Relação N:N bidirecional</div>
              <button
                className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded bg-purple-600 px-2 py-1.5 text-[11px] font-semibold text-white shadow-xs hover:bg-purple-700 transition-colors"
                onClick={() => convertNoteToPivot(id)}
                title="Cria uma tabela pivot real conectando as duas tabelas com chaves estrangeiras"
              >
                <Table2 size={13} /> Converter em tabela pivot
              </button>
            </div>
          )}
          {r.fromColumns.length > 0 && r.fromColumns.length === r.toColumns.length && (
            <button className="rounded bg-slate-100 px-2 py-1 text-slate-700 hover:bg-slate-200" onClick={() => updateRelationship(id, (x) => void (x.kind = 'fk'))}>
              Converter em FK real
            </button>
          )}
        </>
      )}
      <button className="flex items-center gap-1 text-red-600 hover:underline" onClick={() => deleteElements({ nodes: [], edges: [id] })}>
        <Trash2 size={13} /> Remover relação
      </button>
    </div>
  );
}

function EnumInspector({ id }: { id: Id }) {
  const e = useProjectStore((s) => s.doc.schema.enums.find((x) => x.id === id));
  const commit = useProjectStore((s) => s.commit);
  if (!e) return null;
  const upd = (fn: (x: NonNullable<typeof e>) => void) =>
    commit((d) => {
      const x = d.schema.enums.find((y) => y.id === id);
      if (x) fn(x);
    }, 'canvas');
  return (
    <div className="space-y-2">
      <label className="block text-[10px] text-slate-500">
        Nome
        <CommitInput
          value={e.name}
          onCommit={(v) => {
            const name = v.trim();
            if (!name) return;
            commit((d) => {
              const x = d.schema.enums.find((y) => y.id === id)!;
              for (const t of d.schema.tables) for (const c of t.columns) if (c.type.base === x.name) c.type.base = name;
              x.name = name;
            }, 'canvas');
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-500">
        Valores (um por linha)
        <CommitInput
          multiline
          value={e.values.join('\n')}
          className="font-mono"
          onCommit={(v) => upd((x) => void (x.values = v.split('\n').map((s) => s.trim()).filter(Boolean)))}
        />
      </label>
      <button className="flex items-center gap-1 text-[12px] text-red-600 hover:underline" onClick={() => deleteElements({ nodes: [id], edges: [] })}>
        <Trash2 size={13} /> Excluir enum
      </button>
    </div>
  );
}

function NoteInspector({ id }: { id: Id }) {
  const note = useProjectStore((s) => s.doc.notes.find((n) => n.id === id));
  if (!note) return null;
  return (
    <div className="space-y-2">
      <label className="block text-[10px] text-slate-500">
        Título (vira o nome do arquivo .md)
        <CommitInput value={note.title} onCommit={(v) => updateNote(id, (n) => void (n.title = v.trim() || 'Nota'))} />
      </label>
      <div className="flex gap-1.5">
        {Object.entries(NOTE_COLORS).map(([k, c]) => (
          <button
            key={k}
            title={k}
            onClick={() => updateNote(id, (n) => void (n.color = k))}
            className={'h-6 w-6 rounded-full border-2 ' + ((note.color ?? 'yellow') === k ? 'border-indigo-500' : 'border-transparent')}
            style={{ background: c.border }}
          />
        ))}
      </div>
      <p className="text-[11px] text-slate-500">Dê dois cliques na nota para editar o Markdown (Ctrl+Enter conclui).</p>
      <div className="flex items-center gap-3">
        <button className="flex items-center gap-1 text-[12px] text-indigo-600 hover:underline" onClick={() => downloadNote(note)}>
          <Download size={13} /> Exportar .md
        </button>
        <button className="flex items-center gap-1 text-[12px] text-red-600 hover:underline" onClick={() => deleteElements({ nodes: [id], edges: [] })}>
          <Trash2 size={13} /> Excluir
        </button>
      </div>
    </div>
  );
}

export function Inspector() {
  const nodes = useUi((s) => s.selectedNodes);
  const edges = useUi((s) => s.selectedEdges);
  const doc = useProjectStore((s) => s.doc);
  const [collapsed, setCollapsed] = useState(false);
  const readOnly = useProjectStore((s) => s.readOnly);
  const total = nodes.length + edges.length;
  if (!total) return null;

  let title = `${total} selecionados`;
  let body: ReactNode = (
    <div className="space-y-2 text-[12px] text-slate-600">
      <p>Use Exportar → PNG/PDF para exportar a seleção.</p>
      <button className="flex items-center gap-1 text-red-600 hover:underline" onClick={() => deleteElements({ nodes, edges })}>
        <Trash2 size={13} /> Excluir seleção
      </button>
    </div>
  );
  if (total === 1 && nodes.length === 1) {
    const id = nodes[0];
    const t = tableById(doc.schema, id);
    if (t) {
      title = 'Tabela';
      body = <TableInspector table={t} />;
    } else if (doc.schema.enums.some((e) => e.id === id)) {
      title = 'Enum';
      body = <EnumInspector id={id} />;
    } else if (doc.notes.some((n) => n.id === id)) {
      title = 'Nota';
      body = <NoteInspector id={id} />;
    }
  } else if (total === 1 && edges.length === 1) {
    title = 'Relação';
    body = <RelationshipInspector id={edges[0]} />;
  }

  return (
    <div className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[310px] flex-col rounded-xl border border-slate-200 bg-white/97 shadow-lg">
      <button className="flex items-center justify-between px-3 py-2 text-[12px] font-semibold text-slate-700" onClick={() => setCollapsed(!collapsed)}>
        {title}
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {!collapsed && (
        // no modo visualização o inspetor só mostra (fieldset desabilita todos os campos e botões)
        <fieldset disabled={readOnly} className="min-w-0 overflow-y-auto px-3 pb-3 disabled:opacity-80">
          {body}
        </fieldset>
      )}
    </div>
  );
}
