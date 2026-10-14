import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin-api.js';
import { createApi } from '../src/api.js';
import { config } from '../src/config.js';
import { LoginLimiter } from '../src/core/admin-auth.js';
import type { App } from '../src/core/service.js';
import { openDb } from '../src/db.js';

const TOKEN = '123:test-token';
const SETUP = 'setup-code-123';
const NAMES: Record<number, string> = { 1: 'Аня', 2: 'Борис' };

function initData(id: number): string {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: NAMES[id] }) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

let http: Hono;
let sent: [string, string][];

/** Клиент сайта-админки со своей cookie, как отдельный браузер. */
function browser() {
  let cookie = '';
  return async (method: string, url: string, body?: unknown) => {
    const res = await http.request(`/api/admin${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!.includes('=;') || /Max-Age=0/i.test(set) ? '' : set.split(';')[0]!;
    return res;
  };
}

/** Пользователь миниаппа. */
const user = (id: number, method: string, url: string, body?: unknown) =>
  http.request(`/api${url}`, {
    method,
    headers: { authorization: `tma ${initData(id)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  config.botToken = TOKEN;
  config.devTgId = '';
  config.adminSetupCode = SETUP;
  sent = [];
  const app: App = { db: await openDb(), llm: null, send: async (chatId, text) => void sent.push([chatId, text]) };
  http = new Hono();
  http.route('/', createAdminApi(app));
  http.route('/', createApi(app));
});

async function registeredAdmin() {
  const admin = browser();
  expect((await admin('POST', '/register', { login: 'Kostya', name: 'Костя', password: 'correct-horse', invite: SETUP })).status).toBe(200);
  return admin;
}

describe('вход в админку', () => {
  it('первый админ регистрируется только по коду установки', async () => {
    const guest = browser();
    expect((await (await guest('GET', '/setup')).json()).needsSetup).toBe(true);
    expect((await guest('POST', '/register', { login: 'x', name: 'x', password: 'long-password', invite: '' })).status).toBe(400);
    expect((await guest('POST', '/register', { login: 'hacker', name: 'x', password: 'long-password', invite: 'wrong' })).status).toBe(403);
    expect((await guest('POST', '/register', { login: 'kostya', name: 'К', password: 'short', invite: SETUP })).status).toBe(400);

    const admin = await registeredAdmin();
    expect((await (await admin('GET', '/me')).json()).admin).toMatchObject({ login: 'kostya', name: 'Костя' });
    // код установки больше не работает: админ уже есть
    expect((await guest('POST', '/register', { login: 'second', name: 'x', password: 'long-password', invite: SETUP })).status).toBe(403);
    expect((await (await guest('GET', '/setup')).json()).needsSetup).toBe(false);
  });

  it('без входа данные закрыты; вход, выход и неверный пароль', async () => {
    await registeredAdmin();
    const other = browser();
    expect((await other('GET', '/stats')).status).toBe(401);
    expect((await other('POST', '/login', { login: 'kostya', password: 'wrong-password' })).status).toBe(401);
    expect((await other('POST', '/login', { login: '  KOSTYA ', password: 'correct-horse' })).status).toBe(200);
    expect((await other('GET', '/stats')).status).toBe(200);
    await other('POST', '/logout', {});
    expect((await other('GET', '/stats')).status).toBe(401);
  });

  it('изменения принимаются только в JSON', async () => {
    const res = await http.request('/api/admin/login', { method: 'POST', body: 'login=kostya&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(415);
  });

  it('приглашение одноразовое, новый админ входит своим паролем', async () => {
    const admin = await registeredAdmin();
    const { code } = await (await admin('POST', '/invites', {})).json();
    const newcomer = browser();
    expect((await newcomer('POST', '/register', { login: 'anna', name: 'Аня', password: 'another-pass', invite: code })).status).toBe(200);
    expect((await browser()('POST', '/register', { login: 'boris', name: 'Б', password: 'another-pass', invite: code })).status).toBe(403);
    expect((await (await admin('GET', '/admins')).json()).admins).toHaveLength(2);

    const annaId = (await (await newcomer('GET', '/me')).json()).admin.id;
    expect((await newcomer('DELETE', `/admins/${annaId}`)).status).toBe(400);
    expect((await admin('DELETE', `/admins/${annaId}`)).status).toBe(200);
    expect((await newcomer('GET', '/me')).status).toBe(401);
  });

  it('смена пароля выкидывает другие сессии', async () => {
    const laptop = await registeredAdmin();
    const phone = browser();
    await phone('POST', '/login', { login: 'kostya', password: 'correct-horse' });
    expect((await laptop('POST', '/password', { current: 'nope', next: 'new-password-1' })).status).toBe(400);
    expect((await laptop('POST', '/password', { current: 'correct-horse', next: 'new-password-1' })).status).toBe(200);
    expect((await laptop('GET', '/me')).status).toBe(200);
    expect((await phone('GET', '/me')).status).toBe(401);
    expect((await browser()('POST', '/login', { login: 'kostya', password: 'new-password-1' })).status).toBe(200);
  });

  it('перебор пароля упирается в лимит', () => {
    const limiter = new LoginLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) limiter.fail('ip|login', 1000);
    expect(limiter.blocked('ip|login', 1000)).toBe(true);
    expect(limiter.blocked('ip|other', 1000)).toBe(false);
    expect(limiter.blocked('ip|login', 1000 + 61_000)).toBe(false);
  });
});

describe('данные в админке', () => {
  it('статистика, блокировка, сообщение, удаление и журнал действий', { timeout: 30_000 }, async () => {
    const admin = await registeredAdmin();
    for (const id of [1, 2]) {
      const roomId = (await (await user(id, 'GET', '/me')).json()).activeRoomId;
      await user(id, 'POST', `/rooms/${roomId}/operations`, { text: '400 кофе' });
    }

    const stats = await (await admin('GET', '/stats')).json();
    expect(stats.users).toMatchObject({ total: 2, active: { d1: 2 } });
    expect(stats.operations).toMatchObject({ total: 2, sum: 80000 });
    expect(stats.topItems[0]).toMatchObject({ item: 'Кофе', count: 2 });

    const anna = (await (await admin('GET', '/users?q=Аня')).json()).users[0];
    await admin('POST', `/users/${anna.id}/block`, { blocked: true });
    expect((await user(1, 'GET', '/me')).status).toBe(403);
    await admin('POST', `/users/${anna.id}/block`, { blocked: false });
    expect((await user(1, 'GET', '/me')).status).toBe(200);

    await admin('POST', `/users/${anna.id}/message`, { text: 'Привет!' });
    expect(sent).toEqual([['1', 'Привет!']]);

    const boris = (await (await admin('GET', '/users?q=Борис')).json()).users[0];
    expect((await admin('DELETE', `/users/${boris.id}`)).status).toBe(200);
    expect((await (await admin('GET', '/journals')).json()).journals).toHaveLength(1);

    const actions = (await (await admin('GET', '/audit')).json()).entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['user_deleted', 'user_messaged', 'user_unblocked', 'user_blocked', 'register']);
  });
});
