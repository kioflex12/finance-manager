import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin-api.js';
import { createApi } from '../src/api.js';
import { config } from '../src/config.js';
import { createSession, LoginLimiter, validSession } from '../src/core/admin-auth.js';
import type { App } from '../src/core/service.js';
import { openDb } from '../src/db.js';

const TOKEN = '123:test-token';
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
  config.adminLogin = 'admin';
  config.adminPassword = 'correct-horse';
  sent = [];
  const app: App = { db: await openDb(), llm: null, send: async (chatId, text) => void sent.push([chatId, text]) };
  http = new Hono();
  http.route('/', createAdminApi(app));
  http.route('/', createApi(app));
});

async function loggedInAdmin() {
  const admin = browser();
  expect((await admin('POST', '/login', { login: 'admin', password: 'correct-horse' })).status).toBe(200);
  return admin;
}

describe('вход в админку', () => {
  it('только логин и пароль из настроек; регистрации нет', async () => {
    const guest = browser();
    expect((await guest('GET', '/stats')).status).toBe(401);
    expect((await guest('POST', '/login', { login: 'admin', password: 'wrong-password' })).status).toBe(401);
    expect((await guest('POST', '/login', { login: 'other', password: 'correct-horse' })).status).toBe(401);
    expect((await guest('POST', '/register', { login: 'x', password: 'long-password' })).status).toBe(401);

    expect((await guest('POST', '/login', { login: '  ADMIN ', password: 'correct-horse' })).status).toBe(200);
    expect((await (await guest('GET', '/me')).json()).login).toBe('admin');
    expect((await guest('GET', '/stats')).status).toBe(200);
    await guest('POST', '/logout', {});
    expect((await guest('GET', '/stats')).status).toBe(401);
  });

  it('без настроенных данных войти нельзя вообще', async () => {
    config.adminPassword = '';
    expect((await browser()('POST', '/login', { login: 'admin', password: '' })).status).toBe(401);
  });

  it('смена пароля в настройках завершает старые сессии', async () => {
    const admin = await loggedInAdmin();
    config.adminPassword = 'new-password';
    expect((await admin('GET', '/me')).status).toBe(401);
  });

  it('подделанная или просроченная cookie не пускает', async () => {
    const creds = { login: 'admin', password: 'correct-horse' };
    const token = createSession(creds, Date.now());
    expect(validSession(creds, token)).toBe(true);
    expect(validSession(creds, token.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')))).toBe(false);
    expect(validSession(creds, `${Date.now() + 999_999_999}.${token.split('.')[1]}`)).toBe(false);
    expect(validSession(creds, createSession(creds, Date.now() - 30 * 86_400_000))).toBe(false);
  });

  it('изменения принимаются только в JSON', async () => {
    const res = await http.request('/api/admin/login', { method: 'POST', body: 'login=admin&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(415);
  });

  it('перебор пароля упирается в лимит', () => {
    const limiter = new LoginLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) limiter.fail('ip', 1000);
    expect(limiter.blocked('ip', 1000)).toBe(true);
    expect(limiter.blocked('other-ip', 1000)).toBe(false);
    expect(limiter.blocked('ip', 1000 + 61_000)).toBe(false);
  });
});

describe('данные в админке', () => {
  it('статистика, блокировка, сообщение, удаление и журнал действий', { timeout: 30_000 }, async () => {
    const admin = await loggedInAdmin();
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
    expect(actions).toEqual(['user_deleted', 'user_messaged', 'user_unblocked', 'user_blocked', 'login']);
  });
});
