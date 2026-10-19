import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { api, ok } from './api/client';
import { keys, queryClient } from './api/queries';
import { CheckEmailPage, ForgotPage, LoginPage, ResetPasswordPage, SignupPage } from './routes/auth';
import { Dashboard } from './routes/Dashboard';
import { CanvasEditor, LocalEditor, ProjectRedirect } from './routes/editors';

/** Exige login: sem sessão, vai para o login e volta depois */
async function requireAuth({ location }: { location: { href: string } }) {
  const me = await queryClient.fetchQuery({ queryKey: keys.me, queryFn: () => ok(api.me.$get()), staleTime: 30_000 }).catch(() => null);
  if (!me?.user) throw redirect({ to: '/login', search: { redirect: location.href } });
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const authed = createRoute({ getParentRoute: () => rootRoute, id: 'authed', beforeLoad: requireAuth, component: () => <Outlet /> });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/signup', component: SignupPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/check-email', component: CheckEmailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/forgot', component: ForgotPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/local', component: LocalEditor }),
  authed.addChildren([
    createRoute({ getParentRoute: () => authed, path: '/', component: Dashboard }),
    createRoute({ getParentRoute: () => authed, path: '/p/$projectId', component: ProjectRedirect }),
    createRoute({ getParentRoute: () => authed, path: '/p/$projectId/c/$canvasId', component: CanvasEditor }),
  ]),
];

export const router = createRouter({ routeTree: rootRoute.addChildren(routes), defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
