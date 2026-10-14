import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from './config.js';
import * as admin from './core/admin.js';
import * as auth from './core/admin-auth.js';
import * as s from './core/service.js';

type Env = { Variables: { admin: auth.Admin } };

const COOKIE = 'fm_admin';
/** Пауза между сообщениями рассылки: Telegram ограничивает бота примерно 30 сообщениями в секунду. */
const BROADCAST_DELAY_MS = 50;
const MAX_MESSAGE = 4000;

const ERROR_STATUS: Record<auth.RegisterError, 400 | 403 | 409> = {
  bad_login: 400,
  weak_password: 400,
  invite_required: 403,
  invite_invalid: 403,
  login_taken: 409,
};

/**
 * API сайта-админки (/api/admin). Отдельный вход по логину и паролю, сессия в cookie —
 * никак не связан с авторизацией миниаппа через Telegram.
 */
export function createAdminApi(app: s.App): Hono<Env> {
  const api = new Hono<Env>().basePath('/api/admin');
  const limiter = new auth.LoginLimiter();

  const ip = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';

  function startSession(c: Context, token: string) {
    setCookie(c, COOKIE, token, {
      path: '/api/admin',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: auth.SESSION_DAYS * 86_400,
    });
  }

  // запросы, меняющие данные, — только JSON: обычная форма с чужого сайта так отправить не может
  api.use(async (c, next) => {
    if (c.req.method !== 'GET' && !c.req.header('content-type')?.includes('application/json')) {
      return c.json({ error: 'json_required' }, 415);
    }
    await next();
  });

  // ---------- вход ----------

  api.get('/setup', async (c) => c.json({ needsSetup: (await auth.adminCount(app)) === 0 }));

  api.post('/register', async (c) => {
    const body = await c.req.json<{ login?: string; name?: string; password?: string; invite?: string }>();
    const result = await auth.registerAdmin(
      app,
      { login: String(body.login ?? ''), name: String(body.name ?? ''), password: String(body.password ?? ''), invite: String(body.invite ?? '') },
      config.adminSetupCode,
    );
    if (typeof result === 'string') return c.json({ error: result }, ERROR_STATUS[result]);
    startSession(c, await auth.createSession(app, result.id, { ip: ip(c), userAgent: c.req.header('user-agent') ?? '' }));
    await auth.audit(app, result.id, 'register', {}, ip(c));
    return c.json({ admin: result });
  });

  api.post('/login', async (c) => {
    const body = await c.req.json<{ login?: string; password?: string }>();
    const login = auth.normalizeLogin(String(body.login ?? ''));
    const key = `${ip(c)}|${login}`;
    if (limiter.blocked(key)) return c.json({ error: 'too_many_attempts' }, 429);
    const found = await auth.checkCredentials(app, login, String(body.password ?? ''));
    if (!found) {
      limiter.fail(key);
      await auth.audit(app, null, 'login_failed', { login }, ip(c));
      return c.json({ error: 'wrong_credentials' }, 401);
    }
    limiter.reset(key);
    startSession(c, await auth.createSession(app, found.id, { ip: ip(c), userAgent: c.req.header('user-agent') ?? '' }));
    await auth.audit(app, found.id, 'login', {}, ip(c));
    return c.json({ admin: found });
  });

  api.post('/logout', async (c) => {
    await auth.endSession(app, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/api/admin' });
    return c.json({ ok: true });
  });

  // ---------- всё остальное — только с сессией ----------

  api.use(async (c, next) => {
    const found = await auth.sessionAdmin(app, getCookie(c, COOKIE));
    if (!found) return c.json({ error: 'unauthorized' }, 401);
    c.set('admin', found);
    await next();
  });

  const log = (c: Context<Env>, action: string, details: object = {}) => auth.audit(app, c.get('admin').id, action, details, ip(c));

  api.get('/me', (c) => c.json({ admin: c.get('admin') }));

  api.post('/password', async (c) => {
    const body = await c.req.json<{ current?: string; next?: string }>();
    const result = await auth.changePassword(app, c.get('admin').id, String(body.current ?? ''), String(body.next ?? ''));
    if (result !== 'ok') return c.json({ error: result }, 400);
    await auth.endOtherSessions(app, c.get('admin').id, getCookie(c, COOKIE));
    await log(c, 'password_changed');
    return c.json({ ok: true });
  });

  api.get('/admins', async (c) => c.json({ admins: await auth.listAdmins(app) }));

  api.post('/invites', async (c) => {
    const invite = await auth.createInvite(app, c.get('admin').id);
    await log(c, 'invite_created');
    return c.json(invite);
  });

  api.delete('/admins/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (id === c.get('admin').id) return c.json({ error: 'cannot_remove_self' }, 400);
    const target = (await auth.listAdmins(app)).find((a) => a.id === id);
    if (!target) return c.json({ error: 'not_found' }, 404);
    await auth.removeAdmin(app, id);
    await log(c, 'admin_removed', { login: target.login });
    return c.json({ ok: true });
  });

  api.get('/audit', async (c) => c.json({ entries: await auth.auditLog(app) }));

  // ---------- данные приложения ----------

  api.get('/stats', async (c) => c.json(await admin.adminStats(app)));

  api.get('/users', async (c) => c.json({ users: await admin.adminUsers(app, c.req.query('q') ?? '') }));

  api.get('/users/:id', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    return found ? c.json(found) : c.json({ error: 'not_found' }, 404);
  });

  api.post('/users/:id/block', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const { blocked } = await c.req.json<{ blocked: boolean }>();
    await admin.setBlocked(app, found.user.id, Boolean(blocked));
    await log(c, blocked ? 'user_blocked' : 'user_unblocked', { userId: found.user.id, name: found.user.name });
    return c.json({ ok: true });
  });

  api.post('/users/:id/message', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    if (!app.send) return c.json({ error: 'bot_offline' }, 503);
    const text = String((await c.req.json<{ text: string }>()).text ?? '').trim().slice(0, MAX_MESSAGE);
    if (!text) return c.json({ error: 'empty' }, 422);
    try {
      await app.send(found.user.tgId, text);
    } catch {
      // пользователь мог остановить бота
      return c.json({ error: 'not_delivered' }, 502);
    }
    await log(c, 'user_messaged', { userId: found.user.id, name: found.user.name, text });
    return c.json({ ok: true });
  });

  api.delete('/users/:id', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    await admin.deleteUser(app, found.user.id);
    await log(c, 'user_deleted', { userId: found.user.id, name: found.user.name, tgId: found.user.tgId });
    return c.json({ ok: true });
  });

  api.get('/journals', async (c) => c.json({ journals: await admin.adminJournals(app) }));

  api.get('/journals/:id', async (c) => {
    const room = await s.getRoom(app, Number(c.req.param('id')));
    if (!room) return c.json({ error: 'not_found' }, 404);
    const period = await s.currentPeriod(app, room.id);
    return c.json({
      room,
      period,
      stats: period ? await s.periodStats(app, period.id) : null,
      members: (await s.listMembers(app, room.id)).map((m) => ({ id: m.id, name: m.name })),
      periods: await s.listPeriods(app, room.id),
    });
  });

  api.delete('/journals/:id', async (c) => {
    const room = await s.getRoom(app, Number(c.req.param('id')));
    if (!room) return c.json({ error: 'not_found' }, 404);
    await s.deleteRoom(app, room.id);
    await log(c, 'journal_deleted', { journalId: room.id, name: room.name });
    return c.json({ ok: true });
  });

  // рассылка всем незаблокированным; отправляется в фоне, ответ — сколько адресатов
  api.post('/broadcast', async (c) => {
    if (!app.send) return c.json({ error: 'bot_offline' }, 503);
    const text = String((await c.req.json<{ text: string }>()).text ?? '').trim().slice(0, MAX_MESSAGE);
    if (!text) return c.json({ error: 'empty' }, 422);
    const recipients = await admin.adminUserTgIds(app);
    const send = app.send;
    await log(c, 'broadcast', { text, recipients: recipients.length });
    void (async () => {
      let failed = 0;
      for (const tgId of recipients) {
        await send(tgId, text).catch(() => failed++);
        await new Promise((resolve) => setTimeout(resolve, BROADCAST_DELAY_MS));
      }
      console.log(`broadcast: ${recipients.length - failed}/${recipients.length} delivered`);
    })();
    return c.json({ recipients: recipients.length });
  });

  return api;
}
