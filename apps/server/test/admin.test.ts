import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { config } from '../src/config.js';
import type { App } from '../src/core/service.js';
import { openDb } from '../src/db.js';

const TOKEN = '123:test-token';
const ADMIN = 100;
const NAMES: Record<number, string> = { 1: 'Аня', 2: 'Борис', [ADMIN]: 'Админ' };

function initData(id: number): string {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: NAMES[id] ?? `U${id}` }) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('админка', () => {
  let api: ReturnType<typeof createApi>;
  let sent: [string, string][];

  const call = (user: number, method: string, url: string, body?: unknown) =>
    api.request(`/api${url}`, {
      method,
      headers: { authorization: `tma ${initData(user)}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    config.botToken = TOKEN;
    config.devTgId = '';
    config.adminTgIds = [String(ADMIN)];
    sent = [];
    const app: App = {
      db: await openDb(),
      llm: null,
      send: async (chatId, text) => void sent.push([chatId, text]),
    };
    api = createApi(app);
  });

  it('открыта только администратору', async () => {
    expect((await (await call(1, 'GET', '/me')).json()).isAdmin).toBe(false);
    expect((await call(1, 'GET', '/admin/stats')).status).toBe(403);
    expect((await (await call(ADMIN, 'GET', '/me')).json()).isAdmin).toBe(true);
    expect((await call(ADMIN, 'GET', '/admin/stats')).status).toBe(200);
  });

  it('статистика считает пользователей, журналы и траты', { timeout: 30_000 }, async () => {
    for (const user of [1, 2]) {
      const roomId = (await (await call(user, 'GET', '/me')).json()).activeRoomId;
      await call(user, 'POST', `/rooms/${roomId}/operations`, { text: '400 кофе' });
    }
    const stats = await (await call(ADMIN, 'GET', '/admin/stats')).json();
    expect(stats.users).toMatchObject({ total: 3, new1: 3, blocked: 0, active: { d1: 2, d7: 2 } });
    // у администратора журнала нет: он не открывал приложение, только админку
    expect(stats.journals.total).toBe(2);
    expect(stats.operations).toMatchObject({ total: 2, sum: 80000, count1: 2 });
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily.at(-1)).toMatchObject({ operations: 2, active: 2 });
    expect(stats.topItems[0]).toMatchObject({ item: 'Кофе', count: 2 });
    expect(stats.server.appMemoryMb).toBeGreaterThan(0);
  });

  it('блокировка отрезает доступ, админа заблокировать нельзя', async () => {
    await call(1, 'GET', '/me');
    const users = (await (await call(ADMIN, 'GET', '/admin/users?q=Аня')).json()).users;
    expect(users).toHaveLength(1);
    const id = users[0].id;

    expect((await call(ADMIN, 'POST', `/admin/users/${id}/block`, { blocked: true })).status).toBe(200);
    expect((await call(1, 'GET', '/me')).status).toBe(403);
    await call(ADMIN, 'POST', `/admin/users/${id}/block`, { blocked: false });
    expect((await call(1, 'GET', '/me')).status).toBe(200);

    const adminId = (await (await call(ADMIN, 'GET', '/admin/users?q=100')).json()).users[0].id;
    expect((await call(ADMIN, 'POST', `/admin/users/${adminId}/block`, { blocked: true })).status).toBe(403);
  });

  it('удаление пользователя убирает его журналы и траты в общих', { timeout: 30_000 }, async () => {
    const owner = await (await call(1, 'GET', '/me')).json();
    const added = await (await call(1, 'POST', `/rooms/${owner.activeRoomId}/operations`, { text: '400 кофе' })).json();
    await call(2, 'POST', '/join', { code: added.room.inviteCode });
    await call(2, 'POST', `/rooms/${owner.activeRoomId}/operations`, { text: '250 такси' });

    const guestId = (await (await call(ADMIN, 'GET', '/admin/users?q=Борис')).json()).users[0].id;
    expect((await call(ADMIN, 'DELETE', `/admin/users/${guestId}`)).status).toBe(200);

    const room = await (await call(1, 'GET', `/rooms/${owner.activeRoomId}`)).json();
    expect(room.stats.total).toBe(40000);
    expect(room.members).toHaveLength(1);
  });

  it('сообщение пользователю и рассылка уходят через бота', async () => {
    await call(1, 'GET', '/me');
    await call(2, 'GET', '/me');
    const id = (await (await call(ADMIN, 'GET', '/admin/users?q=Аня')).json()).users[0].id;
    expect((await call(ADMIN, 'POST', `/admin/users/${id}/message`, { text: 'Привет!' })).status).toBe(200);
    expect(sent).toEqual([['1', 'Привет!']]);

    const res = await (await call(ADMIN, 'POST', '/admin/broadcast', { text: 'Обновление' })).json();
    expect(res.recipients).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sent.filter(([, text]) => text === 'Обновление').map(([chat]) => chat).sort()).toEqual(['1', '100', '2']);
  });
});
