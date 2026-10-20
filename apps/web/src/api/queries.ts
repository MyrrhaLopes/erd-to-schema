import { QueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError, ok } from './client';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 2 && !(e instanceof ApiError && [401, 403, 404].includes(e.status)), staleTime: 10_000 } },
});

export const keys = {
  me: ['me'] as const,
  projects: (filter: string) => ['projects', filter] as const,
  project: (id: string) => ['project', id] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => ok(api.me.$get()), staleTime: 60_000 });
}

export function useProjects(filter: 'mine' | 'shared' | 'all') {
  return useQuery({ queryKey: keys.projects(filter), queryFn: () => ok(api.projects.$get({ query: { filter } })) });
}

export function useProject(id: string) {
  return useQuery({ queryKey: keys.project(id), queryFn: () => ok(api.projects[':id'].$get({ param: { id } })) });
}

export const sharingKeys = {
  members: (id: string) => ['members', id] as const,
  requests: (id: string) => ['access-requests', id] as const,
  notifications: ['notifications'] as const,
  settings: ['me', 'settings'] as const,
};

export function useMembers(projectId: string, enabled = true) {
  return useQuery({ queryKey: sharingKeys.members(projectId), queryFn: () => ok(api.projects[':id'].members.$get({ param: { id: projectId } })), enabled });
}

export function useAccessRequests(projectId: string, enabled: boolean) {
  return useQuery({ queryKey: sharingKeys.requests(projectId), queryFn: () => ok(api.projects[':id']['access-requests'].$get({ param: { id: projectId } })), enabled });
}

/** Sininho: sem WebSocket próprio, consulta a cada 30 s e ao voltar para a aba */
export function useNotifications(enabled: boolean) {
  return useQuery({ queryKey: sharingKeys.notifications, queryFn: () => ok(api.notifications.$get()), enabled, refetchInterval: 30_000, refetchOnWindowFocus: true });
}

export function useUserSettings() {
  return useQuery({ queryKey: sharingKeys.settings, queryFn: () => ok(api.me.settings.$get()) });
}
