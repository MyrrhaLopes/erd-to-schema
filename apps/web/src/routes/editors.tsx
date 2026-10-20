import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Workflow } from 'lucide-react';
import type { ProjectDetail } from '@erd/contracts';
import { can } from '@erd/contracts';
import { Editor } from '../editor/Editor';
import { kinds } from '@erd/canvas-kinds';
import '../kinds/erd';
import { openLocalSession } from '../collab/local';
import { openRemoteSession } from '../collab/remote';
import { activateSession, deactivateSession } from '../collab/openCanvas';
import { keys, useMe, useMembers, useProject } from '../api/queries';
import { colorOf } from '@erd/contracts';
import { useDirectory } from '../collab/presence';
import { useQueryClient } from '@tanstack/react-query';
import { showToast } from '../store/useUi';
import { ApiError } from '../api/client';
import { useEditorContext } from '../store/useEditorContext';
import type { Session } from '../collab/session';
import { ViewModeBanner } from '../ui/sharing';

/** Abre uma sessão de canvas enquanto o componente está montado (e fecha ao trocar de rota) */
function useCanvasSession(open: (() => Promise<Session>) | null, deps: unknown[]) {
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    open()
      .then((s) => {
        if (cancelled) s.destroy();
        else activateSession(s);
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)));
    return () => {
      cancelled = true;
      deactivateSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return error;
}

export function LocalEditor() {
  useEffect(() => useEditorContext.getState().set({ mode: 'local', project: null, canvasId: null, connection: 'local' }), []);
  const error = useCanvasSession(openLocalSession, []);
  return <Editor error={error} />;
}

/** Abas dos canvases do projeto (o de fluxos de usuário fica "em breve" até a fase 8) */
function CanvasTabs({ project, canvasId }: { project: ProjectDetail; canvasId: string }) {
  return (
    <div className="flex h-8 shrink-0 items-end gap-1 border-b border-slate-200 bg-slate-50 px-3">
      {project.canvases.map((c) => (
        <Link
          key={c.id}
          to="/p/$projectId/c/$canvasId"
          params={{ projectId: project.id, canvasId: c.id }}
          className={'rounded-t-md border border-b-0 px-3 py-1 text-[12px] ' + (c.id === canvasId ? 'border-slate-200 bg-white font-medium text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-700')}
        >
          {c.name}
        </Link>
      ))}
      {kinds()
        .filter((k) => !k.available)
        .map((k) => (
          <span key={k.kind} className="flex cursor-not-allowed items-center gap-1 rounded-t-md px-3 py-1 text-[12px] text-slate-400" title={`${k.label}: em breve`}>
            <Workflow size={12} /> {k.label} <span className="rounded bg-slate-200 px-1 text-[9.5px]">em breve</span>
          </span>
        ))}
    </div>
  );
}

export function CanvasEditor() {
  const { projectId, canvasId } = useParams({ strict: false }) as { projectId: string; canvasId: string };
  const me = useMe();
  const project = useProject(projectId);
  const nav = useNavigate();
  const qc = useQueryClient();
  const p = project.data;
  const userId = me.data?.user?.id;
  const readOnly = p ? !can(p.role, 'edit', p.settings) : true;

  useEffect(() => {
    if (p) useEditorContext.getState().set({ mode: 'remote', project: p, canvasId });
  }, [p, canvasId]);

  // diretório de pessoas do projeto (nome e cor de cada membro): autoria e erros com dono de quem não está online
  const members = useMembers(projectId, !!p);
  useEffect(() => {
    if (members.data) useDirectory.getState().add(members.data.members.map((m) => ({ id: m.userId, name: m.name, color: colorOf(m.color) })));
  }, [members.data]);

  useEffect(() => {
    if (project.error instanceof ApiError && project.error.status === 404) void nav({ to: '/' });
  }, [project.error, nav]);

  const error = useCanvasSession(
    p && userId
      ? () =>
          openRemoteSession({
            canvasId,
            userId,
            readOnly,
            role: p.role,
            color: p.color,
            name: me.data!.user!.name,
            onStateless: (m) => {
              if (m.type === 'restored') {
                showToast(`${m.by ?? 'Alguém'} restaurou a versão "${m.label ?? ''}"`);
                return;
              }
              if (m.type !== 'permission-changed') return;
              if (m.role === null) {
                showToast('Seu acesso a este projeto foi removido');
                void nav({ to: '/' });
                return;
              }
              // o papel mudou com a sessão aberta: recarrega o projeto; se mudou a permissão
              // de edição, a sessão reconecta com um token novo, sem recarregar a página
              showToast(m.role === 'viewer' ? 'Agora você só pode visualizar este projeto' : 'Agora você pode editar este projeto');
              void qc.invalidateQueries({ queryKey: keys.project(projectId) });
            },
            onAccessLost: () => void qc.invalidateQueries({ queryKey: keys.project(projectId) }),
          })
      : null,
    [canvasId, userId, !!p, readOnly],
  );

  if (project.error && !(project.error instanceof ApiError && project.error.status === 404)) return <Editor error={(project.error as Error).message} />;
  return <Editor error={error} tabs={p ? <CanvasTabs project={p} canvasId={canvasId} /> : null} banner={p && p.role === 'viewer' ? <ViewModeBanner project={p} /> : null} />;
}

export function ProjectRedirect() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const project = useProject(projectId);
  const nav = useNavigate();
  useEffect(() => {
    const first = project.data?.canvases[0];
    if (first) void nav({ to: '/p/$projectId/c/$canvasId', params: { projectId, canvasId: first.id }, replace: true });
    if (project.error) void nav({ to: '/', replace: true });
  }, [project.data, project.error, projectId, nav]);
  return <div className="flex h-full items-center justify-center text-sm text-slate-500">Abrindo projeto…</div>;
}
