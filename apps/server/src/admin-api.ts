import { Hono } from 'hono';
import { config } from './config.js';
import * as admin from './core/admin.js';
import * as s from './core/service.js';

type Env = { Variables: { user: s.User } };

/** Пауза между сообщениями рассылки: Telegram ограничивает бота примерно 30 сообщениями в секунду. */
const BROADCAST_DELAY_MS = 50;
const MAX_MESSAGE = 4000;

export const isAdmin = (user: s.User) => config.adminTgIds.includes(user.tgId);

/** API админки: монтируется под /api/admin после общей проверки подписи Telegram. */
export function createAdminApi(app: s.App): Hono<Env> {
  const api = new Hono<Env>();

  api.use(async (c, next) => {
    if (!isAdmin(c.get('user'))) return c.json({ error: 'forbidden' }, 403);
    await next();
  });

  api.get('/stats', async (c) => c.json(await admin.adminStats(app)));

  api.get('/users', async (c) => c.json({ users: await admin.adminUsers(app, c.req.query('q') ?? '') }));

  api.get('/users/:id', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    return found ? c.json({ ...found, isAdmin: config.adminTgIds.includes(found.user.tgId) }) : c.json({ error: 'not_found' }, 404);
  });

  api.post('/users/:id/block', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    // администратора не заблокировать — иначе можно запереть себя снаружи
    if (config.adminTgIds.includes(found.user.tgId)) return c.json({ error: 'forbidden' }, 403);
    const { blocked } = await c.req.json<{ blocked: boolean }>();
    await admin.setBlocked(app, found.user.id, Boolean(blocked));
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
    return c.json({ ok: true });
  });

  api.delete('/users/:id', async (c) => {
    const found = await admin.adminUser(app, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    if (config.adminTgIds.includes(found.user.tgId)) return c.json({ error: 'forbidden' }, 403);
    await admin.deleteUser(app, found.user.id);
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
    return c.json({ ok: true });
  });

  // рассылка всем незаблокированным; отправляется в фоне, ответ — сколько адресатов
  api.post('/broadcast', async (c) => {
    if (!app.send) return c.json({ error: 'bot_offline' }, 503);
    const text = String((await c.req.json<{ text: string }>()).text ?? '').trim().slice(0, MAX_MESSAGE);
    if (!text) return c.json({ error: 'empty' }, 422);
    const recipients = await admin.adminUserTgIds(app);
    const send = app.send;
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
