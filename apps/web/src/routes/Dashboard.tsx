import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { Database, FolderOpen, HardDrive, LogOut, Plus, Search, Settings, Users, X } from 'lucide-react';
import type { ProjectSummary } from '@erd/contracts';
import { codeText, fromProject } from '@erd/crdt';
import { placeNewEntities } from '@erd/model/project';
import { api, authClient, ok, toBase64 } from '../api/client';
import { useMe, useProjects } from '../api/queries';
import { readImportFile } from '../persistence/projectFile';
import { pickFile } from '../persistence/files';
import { NotificationsBell } from '../ui/Notifications';

const ROLE_LABEL = { owner: 'Dono', editor: 'Editor', viewer: 'Leitor' } as const;

export function relTime(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'agora';
  if (d < 3600) return `há ${Math.floor(d / 60)} min`;
  if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function TopBar({ children }: { children?: ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <header className="flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-4">
      <Link to="/" className="flex items-center gap-2 text-slate-800">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
          <Database size={15} />
        </span>
        <span className="text-[14px] font-semibold">ERD Builder</span>
      </Link>
      {children}
      <div className="ml-auto flex items-center gap-2">
        <Link to="/local" className="flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-slate-600 hover:bg-slate-100" title="Modo local, sem conta">
          <HardDrive size={14} /> Modo local
        </Link>
        <NotificationsBell />
        {me.data?.user && (
          <>
            <Link to="/settings" className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-slate-600 hover:bg-slate-100" title="Configurações da conta" data-testid="me">
              {me.data.user.name} <Settings size={13} className="text-slate-400" />
            </Link>
            <button
              title="Sair"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
              onClick={async () => {
                await authClient.signOut();
                qc.clear();
                void nav({ to: '/login' });
              }}
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <Link
      to="/p/$projectId"
      params={{ projectId: p.id }}
      className="group flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow"
      data-testid="project-card"
    >
      <div className="mb-8 flex items-start justify-between gap-2">
        <span className="truncate text-[14px] font-semibold text-slate-800 group-hover:text-indigo-700">{p.name}</span>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-600">{ROLE_LABEL[p.role]}</span>
      </div>
      <div className="mt-auto flex items-center gap-3 text-[11.5px] text-slate-500">
        <span>{relTime(p.updatedAt)}</span>
        <span className="flex items-center gap-1">
          <Users size={12} /> {p.members}
        </span>
        {p.role !== 'owner' && <span className="truncate">de {p.owner.name}</span>}
        {!!p.pendingRequests && <span className="ml-auto rounded-full bg-amber-100 px-1.5 text-[10.5px] text-amber-800">{p.pendingRequests} pedido(s)</span>}
      </div>
    </Link>
  );
}

/** Monta o estado inicial a partir de um arquivo (.zip/.json/.sql/.prisma/.ts): o servidor valida e grava */
async function initialStateFromFile(file: File): Promise<{ name: string; state: string }> {
  const r = await readImportFile(file);
  if (r.kind === 'project') {
    placeNewEntities(r.project);
    return { name: r.project.name, state: toBase64(fromProject(r.project)) };
  }
  const doc = new Y.Doc();
  if (r.kind === 'schema') {
    // texto solto: vai direto para o painel do formato, com a formatação e os comentários; o bot gera o resto
    codeText(doc, r.format).insert(0, r.text);
  } else {
    return { name: file.name.replace(/\.[^.]+$/, ''), state: toBase64(fromProject({ name: file.name, schema: { tables: [], enums: [], relationships: [] }, layout: {}, meta: {}, notes: r.notes })) };
  }
  return { name: file.name.replace(/\.[^.]+$/, ''), state: toBase64(Y.encodeStateAsUpdate(doc)) };
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'empty' | 'sample' | 'import'>('empty');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let initialState: string | undefined;
      let finalName = name.trim();
      if (template === 'import') {
        if (!file) throw new Error('Escolha um arquivo');
        const r = await initialStateFromFile(file);
        initialState = r.state;
        finalName ||= r.name;
      }
      const res = await ok(api.projects.$post({ json: { name: finalName || 'Novo projeto', template: template === 'sample' ? 'sample' : 'empty', initialState } }));
      await qc.invalidateQueries({ queryKey: ['projects'] });
      void nav({ to: '/p/$projectId/c/$canvasId', params: { projectId: res.id, canvasId: res.canvasId } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={onClose}>
      <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Novo projeto</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X size={16} />
          </button>
        </div>
        <label className="mb-3 block text-[12px] font-medium text-slate-600">
          Nome
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Loja" className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500" />
        </label>
        <div className="mb-4 space-y-1.5 text-[13px] text-slate-700">
          {(
            [
              ['empty', 'Projeto vazio'],
              ['sample', 'Exemplo (loja)'],
              ['import', 'Importar arquivo (.zip, .json, .sql, .prisma, .ts, .md)'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="template" checked={template === v} onChange={() => setTemplate(v)} className="accent-indigo-600" />
              {label}
            </label>
          ))}
          {template === 'import' && (
            <button
              type="button"
              onClick={async () => setFile(await pickFile('.zip,.json,.sql,.prisma,.ts,.js,.md'))}
              className="ml-6 flex items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-[12px] hover:bg-slate-50"
            >
              <FolderOpen size={13} /> {file ? file.name : 'Escolher arquivo…'}
            </button>
          )}
        </div>
        {error && <p className="mb-3 rounded-md bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-[13px] hover:bg-slate-100">
            Cancelar
          </button>
          <button disabled={busy} className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
            {busy ? 'Criando…' : 'Criar'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function Dashboard() {
  const [filter, setFilter] = useState<'mine' | 'shared'>('mine');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const projects = useProjects(filter);
  const shown = useMemo(() => (projects.data ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase())), [projects.data, query]);

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto p-6">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg bg-slate-200/60 p-0.5">
            {(
              [
                ['mine', 'Meus projetos'],
                ['shared', 'Compartilhados comigo'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} onClick={() => setFilter(v)} className={'rounded-md px-3 py-1.5 text-[12.5px] ' + (filter === v ? 'bg-white font-medium text-slate-800 shadow-sm' : 'text-slate-500')}>
                {label}
              </button>
            ))}
          </div>
          <label className="flex flex-1 items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px]">
            <Search size={14} className="text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar projeto" className="w-full outline-none" />
          </label>
          <button onClick={() => setCreating(true)} className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700">
            <Plus size={15} /> Novo projeto
          </button>
        </div>
        {projects.isLoading ? (
          <p className="text-[13px] text-slate-500">Carregando…</p>
        ) : projects.error ? (
          <p className="text-[13px] text-red-600">{(projects.error as Error).message}</p>
        ) : shown.length ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-[13px] text-slate-500">
            {filter === 'mine' ? 'Nenhum projeto ainda. Crie o primeiro.' : 'Ninguém compartilhou um projeto com você ainda.'}
          </div>
        )}
      </main>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
