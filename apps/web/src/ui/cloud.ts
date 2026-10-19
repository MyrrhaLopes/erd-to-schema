import * as Y from 'yjs';
import { api, ok, toBase64 } from '../api/client';
import { keys, queryClient } from '../api/queries';
import { getSession } from '../collab/session';
import { useEditorContext } from '../store/useEditorContext';
import { useProjectStore } from '../store/useProjectStore';
import { showToast } from '../store/useUi';

export async function renameProject(id: string, name: string) {
  try {
    await ok(api.projects[':id'].$patch({ param: { id }, json: { name } }));
    const ctx = useEditorContext.getState();
    if (ctx.project?.id === id) ctx.set({ project: { ...ctx.project, name } });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: keys.project(id) });
  } catch (e) {
    showToast('Não foi possível renomear: ' + (e as Error).message);
  }
}

/**
 * "Enviar para a nuvem" (§10): cria um projeto no servidor com o estado do Y.Doc local.
 * Precisa de login; sem sessão, leva para o login e volta para cá.
 */
export async function uploadLocalToCloud() {
  const session = getSession();
  if (!session) return;
  const me = await ok(api.me.$get()).catch(() => null);
  if (!me?.user) {
    location.href = '/login?redirect=' + encodeURIComponent('/local');
    return;
  }
  const name = useProjectStore.getState().name || 'Projeto local';
  try {
    const r = await ok(api.projects.$post({ json: { name, template: 'empty', initialState: toBase64(Y.encodeStateAsUpdate(session.doc)) } }));
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    showToast('Projeto enviado para a nuvem');
    location.href = `/p/${r.id}/c/${r.canvasId}`;
  } catch (e) {
    showToast('Falha ao enviar: ' + (e as Error).message);
  }
}
