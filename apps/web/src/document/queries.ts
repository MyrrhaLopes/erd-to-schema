import { useQuery } from '@tanstack/react-query';
import { api, ok } from '../api/client';

export const driveKeys = {
  config: ['drive', 'config'] as const,
  project: (id: string) => ['drive', 'project', id] as const,
  publications: (canvasId: string) => ['drive', 'publications', canvasId] as const,
  review: (canvasId: string) => ['drive', 'review', canvasId] as const,
};

export function useDriveConfig(enabled = true) {
  return useQuery({ queryKey: driveKeys.config, queryFn: () => ok(api.drive.config.$get()), staleTime: 300_000, enabled });
}

export function useDriveProject(projectId: string | null | undefined) {
  return useQuery({
    queryKey: driveKeys.project(projectId ?? ''),
    queryFn: () => ok(api.projects[':id'].drive.$get({ param: { id: projectId! } })),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

export function usePublications(canvasId: string, enabled = true) {
  return useQuery({
    queryKey: driveKeys.publications(canvasId),
    queryFn: () => ok(api.canvases[':id'].drive.publications.$get({ param: { id: canvasId }, query: {} })),
    enabled,
  });
}

/** O que a API vê para a revisão: o diff desde a última publicação e o número da próxima versão */
export function useServerReview(canvasId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: driveKeys.review(canvasId ?? ''),
    queryFn: () => ok(api.canvases[':id'].drive.review.$get({ param: { id: canvasId! } })),
    enabled: enabled && !!canvasId,
    staleTime: 0,
  });
}
