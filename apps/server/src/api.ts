import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { config } from './config.js';
import * as s from './core/service.js';
import { periodLabel } from './core/text.js';

const INIT_DATA_TTL_SEC = 86_400;

/** Проверяет подпись Telegram Mini App initData и возвращает пользователя из неё. */
export function verifyInitData(initData: string, botToken: string, now = Date.now()): { id: number; name: string } | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (now / 1000 - Number(params.get('auth_date')) > INIT_DATA_TTL_SEC) return null;
  try {
    const user = JSON.parse(params.get('user') ?? '') as { id: number; first_name?: string; last_name?: string };
    return { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' ') };
  } catch {
    return null;
  }
}

type Env = { Variables: { user: s.User } };

export function createApi(app: s.App): Hono<Env> {
  const api = new Hono<Env>().basePath('/api');

  api.use(async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const tg = auth.startsWith('tma ')
      ? verifyInitData(auth.slice(4), config.botToken)
      : config.devTgId
        ? { id: Number(config.devTgId), name: 'Dev' }
        : null;
    if (!tg) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', await s.ensureUser(app, tg));
    await next();
  });

  /** Комната из :roomId, если пользователь в ней состоит. */
  async function memberRoom(user: s.User, id: string): Promise<s.Room | null> {
    const room = await s.getRoom(app, Number(id));
    return room && (await s.isMember(app, room.id, user.id)) ? room : null;
  }

  async function memberOperation(user: s.User, id: string): Promise<s.Operation | null> {
    const op = await s.getOperation(app, Number(id));
    return op && (await s.isMember(app, op.roomId, user.id)) ? op : null;
  }

  async function overview(room: s.Room, periodId?: number) {
    const period = periodId ? await s.getPeriod(app, periodId) : await s.currentPeriod(app, room.id);
    if (!period || period.roomId !== room.id) return { room, period: null, stats: null, budget: null };
    const stats = await s.periodStats(app, period.id);
    return {
      room,
      period: { ...period, label: periodLabel(room, period) },
      stats,
      // остаток «в день» имеет смысл только для идущего периода
      budget: period.closedAt ? null : s.budgetInfo(room, period, stats.total),
    };
  }

  api.get('/me', async (c) => {
    const user = c.get('user');
    const active = await s.ensureActiveRoom(app, user);
    return c.json({ user, activeRoomId: active.id, rooms: await s.listRooms(app, user.id), botUsername: config.botUsername });
  });

  api.post('/join', async (c) => {
    const { code } = await c.req.json<{ code: string }>();
    const room = await s.joinRoom(app, c.get('user'), String(code));
    return room ? c.json({ room }) : c.json({ error: 'not_found' }, 404);
  });

  api.post('/rooms', async (c) => {
    const body = await c.req.json<s.RoomInput>();
    const user = c.get('user');
    const room = await s.createRoom(app, user, {
      name: String(body.name ?? ''),
      periodKind: body.periodKind === 'days' ? 'days' : 'month',
      periodDays: Number(body.periodDays) || undefined,
      autoRenew: Boolean(body.autoRenew),
      budget: toBudget(body.budget),
    });
    await s.setActiveRoom(app, user, room.id);
    return c.json({ room });
  });

  api.get('/rooms/:roomId', async (c) => {
    const room = await memberRoom(c.get('user'), c.req.param('roomId'));
    if (!room) return c.json({ error: 'not_found' }, 404);
    const periodId = Number(c.req.query('periodId')) || undefined;
    return c.json({
      ...(await overview(room, periodId)),
      categories: await s.listCategories(app, room.id),
      members: (await s.listMembers(app, room.id)).map((m) => ({ id: m.id, name: m.name })),
    });
  });

  api.patch('/rooms/:roomId', async (c) => {
    const user = c.get('user');
    const room = await memberRoom(user, c.req.param('roomId'));
    if (!room) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json<{ name?: string; budget?: number | null; autoRenew?: boolean; active?: boolean }>();
    if (body.active) await s.setActiveRoom(app, user, room.id);
    const updated = await s.updateRoom(app, room.id, {
      name: body.name,
      budget: body.budget === undefined ? undefined : toBudget(body.budget),
      autoRenew: body.autoRenew,
    });
    return c.json({ room: updated });
  });

  api.get('/rooms/:roomId/periods', async (c) => {
    const room = await memberRoom(c.get('user'), c.req.param('roomId'));
    if (!room) return c.json({ error: 'not_found' }, 404);
    const periods = await s.listPeriods(app, room.id);
    return c.json({ periods: periods.map((p) => ({ ...p, label: periodLabel(room, p) })) });
  });

  api.post('/rooms/:roomId/periods', async (c) => {
    const room = await memberRoom(c.get('user'), c.req.param('roomId'));
    if (!room) return c.json({ error: 'not_found' }, 404);
    return c.json({ period: await s.startNewPeriod(app, room) });
  });

  api.get('/rooms/:roomId/operations', async (c) => {
    const room = await memberRoom(c.get('user'), c.req.param('roomId'));
    if (!room) return c.json({ error: 'not_found' }, 404);
    const periodId = Number(c.req.query('periodId')) || (await s.currentPeriod(app, room.id))?.id;
    const period = periodId ? await s.getPeriod(app, periodId) : null;
    if (!period || period.roomId !== room.id) return c.json({ operations: [] });
    const cat = c.req.query('categoryId');
    const categoryId = cat === undefined ? undefined : cat === 'none' ? null : Number(cat);
    return c.json({ operations: await s.listOperations(app, period.id, categoryId) });
  });

  api.post('/rooms/:roomId/operations', async (c) => {
    const room = await memberRoom(c.get('user'), c.req.param('roomId'));
    if (!room) return c.json({ error: 'not_found' }, 404);
    const { text } = await c.req.json<{ text: string }>();
    const result = await s.addFromText(app, room, c.get('user'), String(text ?? ''));
    if (result.status !== 'ok') return c.json({ error: result.status }, 422);
    // в миниаппе ждём категорию сразу: экран всё равно перерисуется одним ответом
    const ops = await Promise.all(
      result.ops.map(async (op) => (op.id === result.pendingOpId ? ((await s.categorizePending(app, op.id)) ?? op) : op)),
    );
    return c.json({ operations: ops, ...(await overview(room)) });
  });

  api.patch('/operations/:opId', async (c) => {
    const op = await memberOperation(c.get('user'), c.req.param('opId'));
    if (!op) return c.json({ error: 'not_found' }, 404);
    const { categoryId } = await c.req.json<{ categoryId: number }>();
    const updated = await s.setCategory(app, op, Number(categoryId));
    return updated ? c.json({ operation: updated }) : c.json({ error: 'bad_category' }, 422);
  });

  api.delete('/operations/:opId', async (c) => {
    const op = await memberOperation(c.get('user'), c.req.param('opId'));
    if (!op) return c.json({ error: 'not_found' }, 404);
    await s.deleteOperation(app, op.id);
    return c.json({ ok: true });
  });

  api.onError((err, c) => {
    console.error('api error', err);
    return c.json({ error: 'internal' }, 500);
  });

  return api;
}

/** Бюджет приходит в копейках; пусто, ноль и мусор — «без бюджета». */
function toBudget(value: unknown): number | null {
  const n = Math.round(Number(value));
  return Number.isSafeInteger(n) && n > 0 && n <= 2_000_000_000 ? n : null;
}
