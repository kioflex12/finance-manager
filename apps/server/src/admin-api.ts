import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from './config.js';
import * as admin from './core/admin.js';
import * as auth from './core/admin-auth.js';
import * as s from './core/service.js';

const COOKIE = 'fm_admin';
/** Пауза между сообщениями рассылки: Telegram ограничивает бота примерно 30 сообщениями в секунду. */
const BROADCAST_DELAY_MS = 50;
const MAX_MESSAGE = 4000;

/**
 * API сайта-админки (/api/admin). Вход — логин и пароль из настроек сервера,
 * сессия — подписанная cookie. С авторизацией миниаппа через Telegram никак не связан.
 */
export function createAdminApi(app: s.App): Hono {
  const api = new Hono().basePath('/api/admin');
  const limiter = new auth.LoginLimiter();
  const credentials = () => ({ login: config.adminLogin, password: config.adminPassword });

  const ip = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';

  // запросы, меняющие данные, — только JSON: обычная форма с чужого сайта так отправить не может
  api.use(async (c, next) => {
    if (c.req.method !== 'GET' && !c.req.header('content-type')?.includes('application/json')) {
      return c.json({ error: 'json_required' }, 415);
    }
    await next();
  });

  api.post('/login', async (c) => {
    const body = await c.req.json<{ login?: string; password?: string }>();
    const key = ip(c);
    if (limiter.blocked(key)) return c.json({ error: 'too_many_attempts' }, 429);
    if (!auth.checkLogin(credentials(), String(body.login ?? ''), String(body.password ?? ''))) {
      limiter.fail(key);
      await auth.audit(app, 'login_failed', { login: String(body.login ?? '').slice(0, 64) }, ip(c));
      return c.json({ error: 'wrong_credentials' }, 401);
    }
    limiter.reset(key);
    setCookie(c, COOKIE, auth.createSession(credentials()), {
      path: '/api/admin',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: auth.SESSION_DAYS * 86_400,
    });
    await auth.audit(app, 'login', {}, ip(c));
    return c.json({ login: config.adminLogin });
  });

  api.post('/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/api/admin' });
    return c.json({ ok: true });
  });

  // всё остальное — только после входа
  api.use(async (c, next) => {
    if (!auth.validSession(credentials(), getCookie(c, COOKIE))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  const log = (c: Context, action: string, details: object = {}) => auth.audit(app, action, details, ip(c));

  api.get('/me', (c) => c.json({ login: config.adminLogin }));

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
