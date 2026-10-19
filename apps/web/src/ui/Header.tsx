import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Database,
  Eye,
  FileDown,
  FolderOpen,
  HelpCircle,
  ImageDown,
  LayoutGrid,
  NotebookText,
  PanelRight,
  Redo2,
  Undo2,
} from 'lucide-react';
import { useProjectStore, getProject, undo, redo } from '../store/useProjectStore';
import { useUi, showToast } from '../store/useUi';
import { allTags } from '@erd/model/tags';
import { autoLayout, emptyProject } from '@erd/model/project';
import { exportProjectJson, exportProjectZip, readImportFile } from '../persistence/projectFile';
import { pickFile } from '../persistence/files';
import { exportNotesZip } from '../persistence/notes';
import { buildSampleProject } from '../collab/sample';
import { getSession } from '../collab/session';
import { codeText, IMPORT_ORIGIN } from '@erd/crdt';
import { computeVisibility } from '../canvas/derive';
import { FORMAT_LABEL } from '@erd/model/types';

function Popover({ button, children, align = 'left' }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen(!open)}>{button(open)}</div>
      {open && (
        <div className={'absolute top-full z-50 mt-1 min-w-[230px] rounded-lg border border-slate-200 bg-white p-1 shadow-lg ' + (align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const MenuItem = ({ onClick, children, hint }: { onClick: () => void; children: ReactNode; hint?: string }) => (
  <button onClick={onClick} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-slate-100">
    {children}
    {hint && <span className="ml-auto text-[10.5px] text-slate-400">{hint}</span>}
  </button>
);

const HeaderButton = ({ children, title, onClick, active }: { children: ReactNode; title?: string; onClick?: () => void; active?: boolean }) => (
  <button
    title={title}
    onClick={onClick}
    className={'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] ' + (active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100')}
  >
    {children}
  </button>
);

function Check({ checked, onChange, label, sub }: { checked: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-indigo-600" />
      {label}
      {sub && <span className="ml-auto text-[10.5px] text-slate-400">{sub}</span>}
    </label>
  );
}

function ViewFilters() {
  const view = useProjectStore((s) => s.view);
  const doc = useProjectStore((s) => s.doc);
  const setView = useProjectStore((s) => s.setView);
  const project = { version: 1 as const, name: '', view, ...doc };
  const tags = allTags(project);
  const vis = computeVisibility(project);
  const toggleTag = (t: string, show: boolean) =>
    setView((v) => {
      v.hiddenTags = show ? v.hiddenTags.filter((x) => x !== t) : [...new Set([...v.hiddenTags, t])];
    });
  const LABEL: Record<string, string> = { pivot: 'Tabelas pivot (N:N)', history: 'Tabelas de histórico', enum: 'Enums' };
  return (
    <div className="w-64">
      <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Mostrar</div>
      <Check checked={view.showNoteRelations} onChange={(v) => setView((x) => void (x.showNoteRelations = v))} label="Relações-nota" sub="tracejadas" />
      <Check checked={view.showNotes} onChange={(v) => setView((x) => void (x.showNotes = v))} label="Blocos de nota" sub={String(doc.notes.length)} />
      <Check checked={view.showEnums && !view.hiddenTags.includes('enum')} onChange={(v) => setView((x) => void ((x.showEnums = v), (x.hiddenTags = x.hiddenTags.filter((t) => t !== 'enum'))))} label="Enums" sub={String(doc.schema.enums.length)} />
      {tags
        .filter((t) => t !== 'enum')
        .map((t) => (
          <Check key={t} checked={!view.hiddenTags.includes(t)} onChange={(v) => toggleTag(t, v)} label={LABEL[t] ?? `Tag: ${t}`} />
        ))}
      <div className="mt-1 border-t border-slate-100 pt-1.5">
        <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Cardinalidade das Notas</div>
        <div className="flex flex-col gap-1 px-2 py-1 text-[12px] text-slate-700">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="cardinalityStyle"
              checked={(view.cardinalityStyle ?? 'look-across') === 'look-across'}
              onChange={() => setView((x) => void (x.cardinalityStyle = 'look-across'))}
              className="accent-indigo-600"
            />
            Acima da seta (look-across)
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="cardinalityStyle"
              checked={view.cardinalityStyle === 'below-label'}
              onChange={() => setView((x) => void (x.cardinalityStyle = 'below-label'))}
              className="accent-indigo-600"
            />
            Abaixo do título da relação
          </label>
        </div>
      </div>
      <div className="mt-1 border-t border-slate-100 px-2 py-1.5 text-[10.5px] text-slate-400">
        {vis.hiddenTables.size} tabela(s) oculta(s). Pivots ocultos viram uma aresta N:N direta.
      </div>
    </div>
  );
}

export function Header() {
  const name = useProjectStore((s) => s.name);
  const setName = useProjectStore((s) => s.setName);
  const commit = useProjectStore((s) => s.commit);
  const loadProject = useProjectStore((s) => s.loadProject);
  const readOnly = useProjectStore((s) => s.readOnly);
  const panelOpen = useUi((s) => s.panelOpen);
  const set = useUi((s) => s.set);
  const canUndo = useProjectStore((s) => s.canUndo);
  const canRedo = useProjectStore((s) => s.canRedo);
  const [draftName, setDraftName] = useState(name);
  const editingName = useRef(false);
  useEffect(() => {
    if (!editingName.current) setDraftName(name);
  }, [name]);

  const openFile = async () => {
    const f = await pickFile('.zip,.json,.sql,.prisma,.ts,.js,.md');
    if (!f) return;
    try {
      const r = await readImportFile(f);
      if (r.kind === 'project') {
        loadProject(r.project);
        showToast(`Projeto "${r.project.name}" aberto`);
      } else if (r.kind === 'schema') {
        const session = getSession();
        if (!session) return;
        set({ panelTab: r.format, panelOpen: true });
        // o texto importado entra no painel como está (formatação e comentários preservados) e o bot o traduz
        const t = codeText(session.doc, r.format);
        session.doc.transact(() => {
          t.delete(0, t.length);
          t.insert(0, r.text);
        }, IMPORT_ORIGIN);
        session.bot.flush(r.format);
        showToast(`${FORMAT_LABEL[r.format]} importado`);
      } else {
        commit((d) => {
          let y = 0;
          for (const n of r.notes) {
            d.notes.push(n);
            d.layout[n.id] = { x: -340, y, w: 260, h: 180 };
            y += 200;
          }
        }, 'canvas', [`${r.notes.length} nota(s) importada(s)`]);
      }
    } catch (e) {
      alert('Não foi possível abrir: ' + (e as Error).message);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3">
      <div className="mr-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
          <Database size={15} />
        </span>
        <input
          value={draftName}
          readOnly={readOnly}
          onFocus={() => (editingName.current = true)}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => {
            editingName.current = false;
            if (draftName.trim()) setName(draftName.trim());
            else setDraftName(name);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="w-48 rounded px-1.5 py-1 text-[13.5px] font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:bg-slate-50"
          title="Nome do projeto"
        />
      </div>

      <Popover
        button={() => (
          <HeaderButton>
            <FolderOpen size={15} /> Arquivo <ChevronDown size={12} />
          </HeaderButton>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                close();
                if (confirm('Criar um projeto vazio? O atual continua disponível se você salvou o .zip.')) loadProject(emptyProject());
              }}
            >
              Novo projeto vazio
            </MenuItem>
            <MenuItem
              onClick={async () => {
                close();
                if (confirm('Carregar o projeto de exemplo? O projeto atual será substituído.')) loadProject(await buildSampleProject());
              }}
            >
              Carregar exemplo
            </MenuItem>
            <div className="my-1 border-t border-slate-100" />
            <MenuItem
              hint=".zip .json .sql .prisma .ts .md"
              onClick={() => {
                close();
                void openFile();
              }}
            >
              Abrir / importar…
            </MenuItem>
            <MenuItem
              hint=".zip"
              onClick={() => {
                close();
                void exportProjectZip(getProject());
              }}
            >
              Salvar projeto
            </MenuItem>
            <MenuItem
              hint=".json"
              onClick={() => {
                close();
                void exportProjectJson(getProject());
              }}
            >
              Exportar JSON do modelo
            </MenuItem>
          </>
        )}
      </Popover>

      <Popover
        button={(open) => (
          <HeaderButton active={open}>
            <Eye size={15} /> Visualização <ChevronDown size={12} />
          </HeaderButton>
        )}
      >
        {() => <ViewFilters />}
      </Popover>

      <HeaderButton title="Exportar seleção (ou tudo) como PNG/PDF" onClick={() => set({ exportOpen: true })}>
        <ImageDown size={15} /> PNG/PDF
      </HeaderButton>
      <HeaderButton
        title="Exportar as notas visíveis como .md (zip)"
        onClick={() => {
          const p = getProject();
          const notes = p.view.showNotes ? p.notes : [];
          if (!notes.length) return showToast('Nenhuma nota visível');
          exportNotesZip(notes, p.name);
        }}
      >
        <NotebookText size={15} /> Notas .md
      </HeaderButton>
      <HeaderButton
        title="Organizar automaticamente (tabelas mãe à esquerda)"
        onClick={() =>
          commit((d) => {
            autoLayout(d as never);
          }, 'canvas')
        }
      >
        <LayoutGrid size={15} /> Organizar
      </HeaderButton>

      <div className="ml-auto flex items-center gap-1">
        <button title="Desfazer (Ctrl+Z)" disabled={!canUndo} onClick={undo} className="rounded p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Undo2 size={16} />
        </button>
        <button title="Refazer (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo} className="rounded p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30">
          <Redo2 size={16} />
        </button>
        <div className="mx-1 h-5 w-px bg-slate-200" />
        <HeaderButton title="Atalhos (?)" onClick={() => set({ helpOpen: true })}>
          <HelpCircle size={15} />
        </HeaderButton>
        <HeaderButton title="Painel de código" active={panelOpen} onClick={() => set({ panelOpen: !panelOpen })}>
          <PanelRight size={15} /> Código
        </HeaderButton>
        <HeaderButton title="Salvar projeto (.zip)" onClick={() => void exportProjectZip(getProject())}>
          <FileDown size={15} />
        </HeaderButton>
      </div>
    </header>
  );
}
