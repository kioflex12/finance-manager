import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi, verifyInitData } from '../src/api.js';
import { config } from '../src/config.js';
import type { App } from '../src/core/service.js';
import { openDb } from '../src/db.js';

const TOKEN = '123:test-token';

function initData(user: { id: number; first_name: string }, token = TOKEN, authDate = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user), query_id: 'q' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('verifyInitData', () => {
  it('принимает подпись своего бота', () => {
    expect(verifyInitData(initData({ id: 7, first_name: 'Костя' }), TOKEN)).toEqual({ id: 7, name: 'Костя' });
  });
  it('отклоняет чужую подпись, подмену и просроченные данные', () => {
    expect(verifyInitData(initData({ id: 7, first_name: 'Костя' }, 'other'), TOKEN)).toBeNull();
    expect(verifyInitData(initData({ id: 7, first_name: 'Костя' }).replace('%22id%22%3A7', '%22id%22%3A8'), TOKEN)).toBeNull();
    expect(verifyInitData(initData({ id: 7, first_name: 'Костя' }, TOKEN, 1), TOKEN)).toBeNull();
    expect(verifyInitData('', TOKEN)).toBeNull();
  });
});

describe('API', () => {
  let api: ReturnType<typeof createApi>;

  const call = (user: number, method: string, url: string, body?: unknown) =>
    api.request(`/api${url}`, {
      method,
      headers: { authorization: `tma ${initData({ id: user, first_name: `U${user}` })}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    config.botToken = TOKEN;
    config.devTgId = '';
    const app: App = { db: await openDb(), llm: null };
    api = createApi(app);
  });

  it('без подписи — 401', async () => {
    expect((await api.request('/api/me')).status).toBe(401);
  });

  it('путь пользователя: запись, обзор, смена категории, отмена', async () => {
    const me = await (await call(1, 'GET', '/me')).json();
    const roomId = me.activeRoomId;

    await call(1, 'PATCH', `/rooms/${roomId}`, { budget: 5000000 });
    const added = await (await call(1, 'POST', `/rooms/${roomId}/operations`, { text: '400 продукты' })).json();
    expect(added.operations[0]).toMatchObject({ amount: 40000, category: { name: 'Другое' } });
    expect(added.stats.total).toBe(40000);
    expect(added.budget.left).toBe(4960000);

    const room = await (await call(1, 'GET', `/rooms/${roomId}`)).json();
    const food = room.categories.find((c: { name: string }) => c.name === 'Продукты');
    const opId = added.operations[0].id;
    const patched = await (await call(1, 'PATCH', `/operations/${opId}`, { categoryId: food.id })).json();
    expect(patched.operation.category.name).toBe('Продукты');

    // исправление выучено: следующая такая же трата сразу в нужной категории
    const again = await (await call(1, 'POST', `/rooms/${roomId}/operations`, { text: 'продукты 100' })).json();
    expect(again.operations[0].category.name).toBe('Продукты');

    const list = await (await call(1, 'GET', `/rooms/${roomId}/operations?categoryId=${food.id}`)).json();
    expect(list.operations).toHaveLength(2);

    expect((await call(1, 'DELETE', `/operations/${opId}`)).status).toBe(200);
    expect((await (await call(1, 'GET', `/rooms/${roomId}`)).json()).stats.total).toBe(10000);
    expect((await call(1, 'POST', `/rooms/${roomId}/operations`, { text: 'привет' })).status).toBe(422);
  });

  it('сумму траты можно исправить, отдельно или вместе с категорией', async () => {
    const roomId = (await (await call(1, 'GET', '/me')).json()).activeRoomId;
    const added = await (await call(1, 'POST', `/rooms/${roomId}/operations`, { text: '400 продукты' })).json();
    const opId = added.operations[0].id;
    const food = (await (await call(1, 'GET', `/rooms/${roomId}`)).json()).categories.find((c: { name: string }) => c.name === 'Продукты');

    const fixed = await (await call(1, 'PATCH', `/operations/${opId}`, { amount: 45050 })).json();
    expect(fixed.operation.amount).toBe(45050);
    expect((await (await call(1, 'GET', `/rooms/${roomId}`)).json()).stats.total).toBe(45050);

    const both = await (await call(1, 'PATCH', `/operations/${opId}`, { amount: 50000, categoryId: food.id })).json();
    expect(both.operation).toMatchObject({ amount: 50000, category: { name: 'Продукты' } });

    for (const amount of [0, -100, 1e12, 'много']) {
      expect((await call(1, 'PATCH', `/operations/${opId}`, { amount })).status).toBe(422);
    }
    expect((await call(2, 'PATCH', `/operations/${opId}`, { amount: 100 })).status).toBe(404);
  });

  it('чужие комнаты и операции недоступны, пока не вступил по приглашению', async () => {
    const roomId = (await (await call(1, 'GET', '/me')).json()).activeRoomId;
    const added = await (await call(1, 'POST', `/rooms/${roomId}/operations`, { text: '400 продукты' })).json();
    const opId = added.operations[0].id;

    expect((await call(2, 'GET', `/rooms/${roomId}`)).status).toBe(404);
    expect((await call(2, 'GET', `/rooms/${roomId}/operations`)).status).toBe(404);
    expect((await call(2, 'POST', `/rooms/${roomId}/operations`, { text: '1 x' })).status).toBe(404);
    expect((await call(2, 'DELETE', `/operations/${opId}`)).status).toBe(404);
    expect((await call(2, 'POST', '/join', { code: 'wrong' })).status).toBe(404);

    expect((await call(2, 'POST', '/join', { code: added.room.inviteCode })).status).toBe(200);
    const shared = await (await call(2, 'GET', `/rooms/${roomId}`)).json();
    expect(shared.stats.total).toBe(40000);
    expect(shared.members).toHaveLength(2);
  });

  it('удаление и очистка: владелец удаляет и чистит, участник только выходит', async () => {
    const roomId = (await (await call(1, 'GET', '/me')).json()).activeRoomId;
    const added = await (await call(1, 'POST', `/rooms/${roomId}/operations`, { text: '400 продукты' })).json();
    await call(2, 'POST', '/join', { code: added.room.inviteCode });

    expect((await call(2, 'DELETE', `/rooms/${roomId}/operations`)).status).toBe(403);
    expect((await call(1, 'DELETE', `/rooms/${roomId}/operations`)).status).toBe(200);
    expect((await (await call(1, 'GET', `/rooms/${roomId}`)).json()).stats.total).toBe(0);

    // участник выходит — комната остаётся у владельца
    const left = await (await call(2, 'DELETE', `/rooms/${roomId}`)).json();
    expect(left.rooms.some((r: { id: number }) => r.id === roomId)).toBe(false);
    expect((await call(1, 'GET', `/rooms/${roomId}`)).status).toBe(200);

    const patched = await (await call(1, 'PATCH', `/rooms/${roomId}`, { emoji: '🏠', color: 'нет-такого', name: 'Дом' })).json();
    expect(patched.room).toMatchObject({ emoji: '🏠', color: 'violet', name: 'Дом' });

    const gone = await (await call(1, 'DELETE', `/rooms/${roomId}`)).json();
    expect(gone.activeRoomId).not.toBe(roomId);
    expect((await call(1, 'GET', `/rooms/${roomId}`)).status).toBe(404);
  });

  it('комната на срок: создание и история периодов', async () => {
    const created = await (
      await call(1, 'POST', '/rooms', { name: 'Отпуск', periodKind: 'days', periodDays: 10, autoRenew: false, budget: 1000000 })
    ).json();
    expect(created.room).toMatchObject({ name: 'Отпуск', periodKind: 'days', periodDays: 10, autoRenew: false, budget: 1000000 });
    const periods = await (await call(1, 'GET', `/rooms/${created.room.id}/periods`)).json();
    expect(periods.periods).toHaveLength(1);
    expect((await (await call(1, 'GET', '/me')).json()).activeRoomId).toBe(created.room.id);
  });
});
