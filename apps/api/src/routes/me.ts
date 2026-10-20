import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, userSettings } from '@erd/db';
import { EmailPrefsZ, type EmailPrefs } from '@erd/contracts';
import { enabledProviders } from '../auth';
import { requireUser, type AppEnv, type Deps } from '../context';

const DEFAULT_PREFS: EmailPrefs = { accessRequests: true, decisions: true, membership: true, drive: true };

export async function emailPrefs(deps: Pick<Deps, 'db'>, userId: string): Promise<EmailPrefs> {
  const [row] = await deps.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return { ...DEFAULT_PREFS, ...(row?.emailPrefs ?? {}) };
}

export function meRoutes(deps: Deps) {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const user = c.get('user');
      return c.json({
        user: user ? { id: user.id, name: user.name, email: user.email, image: user.image ?? null } : null,
        providers: enabledProviders(deps.env),
      });
    })
    .get('/settings', async (c) => {
      const user = requireUser(c.get('user'));
      return c.json({ emailPrefs: await emailPrefs(deps, user.id) });
    })
    .put('/settings', zValidator('json', EmailPrefsZ.partial()), async (c) => {
      const user = requireUser(c.get('user'));
      const prefs = { ...(await emailPrefs(deps, user.id)), ...c.req.valid('json') };
      await deps.db
        .insert(userSettings)
        .values({ userId: user.id, emailPrefs: prefs })
        .onConflictDoUpdate({ target: userSettings.userId, set: { emailPrefs: prefs, updatedAt: new Date() } });
      return c.json({ emailPrefs: prefs });
    });
}
