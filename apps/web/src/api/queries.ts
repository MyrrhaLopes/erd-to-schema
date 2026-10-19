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
