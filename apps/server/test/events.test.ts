import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { config } from '../src/config.js';
import * as s from '../src/core/service.js';
import { openDb } from '../src/db.js';

const TOKEN = '123:test-token';

function initData(id: number): string {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: `U${id}` }) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

/** Читает поток событий, пока не встретится нужное событие. */
async function waitFor(reader: ReadableStreamDefaultReader<Uint8Array>, event: string): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 15_000;
  while (!buffer.includes(`event: ${event}`)) {
    if (Date.now() > deadline) throw new Error(`не дождался ${event}, пришло: ${buffer}`);
    const { value, done } = await reader.read();
    if (done) throw new Error('поток закрылся');
    buffer += decoder.decode(value);
  }
}

// под нагрузкой полного прогона одна только встроенная база поднимается несколько секунд
it('трата, записанная ботом, сразу приходит событием в открытое приложение', { timeout: 30_000 }, async () => {
  config.botToken = TOKEN;
  config.devTgId = '';
  const app: s.App = { db: await openDb(), llm: null };
  const api = createApi(app);

  // приложение открыто: в журнале пользователя подписка на события
  const me = await (await api.request('/api/me', { headers: { authorization: `tma ${initData(1)}` } })).json();
  const res = await api.request(`/api/rooms/${me.activeRoomId}/events?auth=${encodeURIComponent(initData(1))}`);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  await waitFor(reader, 'ready');

  // бот записывает трату в тот же журнал
  const user = await s.ensureUser(app, { id: 1, name: 'U1' });
  const room = (await s.getRoom(app, me.activeRoomId))!;
  await s.addFromText(app, room, user, '400 продукты');
  await waitFor(reader, 'change');
  await reader.cancel();
});

it('чужой журнал не подписывается, без подписи — 401', { timeout: 30_000 }, async () => {
  config.botToken = TOKEN;
  config.devTgId = '';
  const app: s.App = { db: await openDb(), llm: null };
  const api = createApi(app);
  const me = await (await api.request('/api/me', { headers: { authorization: `tma ${initData(1)}` } })).json();

  expect((await api.request(`/api/rooms/${me.activeRoomId}/events`)).status).toBe(401);
  expect((await api.request(`/api/rooms/${me.activeRoomId}/events?auth=${encodeURIComponent(initData(2))}`)).status).toBe(404);
});
