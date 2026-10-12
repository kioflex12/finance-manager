import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import * as s from '../src/core/service.js';

let app: s.App;
let user: s.User;
let personal: s.Room;
let trip: s.Room;
let food: s.Room;

beforeEach(async () => {
  app = { db: await openDb(), llm: null };
  user = await s.ensureUser(app, { id: 1, name: 'Костя' });
  personal = await s.ensureActiveRoom(app, user);
  trip = await s.createRoom(app, user, { name: 'Отпуск в Сочи', periodKind: 'days', periodDays: 10, autoRenew: false });
  food = await s.createRoom(app, user, { name: 'Продукты', periodKind: 'month', autoRenew: true });
});

describe('журнал, названный в сообщении', () => {
  const pick = (text: string) => {
    const found = s.pickRoom(text, [personal, trip, food]);
    return found ? [found.room.name, found.rest] : null;
  };

  it.each([
    ['в отпуск: 400 такси', 'Отпуск в Сочи', '400 такси'],
    ['отпуск: 400 такси', 'Отпуск в Сочи', '400 такси'],
    ['Отпуск в Сочи: кофеёчек 300', 'Отпуск в Сочи', 'кофеёчек 300'],
    ['#отпуск 400 такси', 'Отпуск в Сочи', '400 такси'],
    ['запиши в отпуск 400 такси', 'Отпуск в Сочи', '400 такси'],
    ['400 такси в отпуск', 'Отпуск в Сочи', '400 такси'],
    ['400 такси в отпуске', 'Отпуск в Сочи', '400 такси'],
    ['в личные траты 250 кофе', 'Личные траты', '250 кофе'],
  ])('%s', (text, room, rest) => {
    expect(pick(text)).toEqual([room, rest]);
  });

  it.each([
    '400 продукты', // обычная трата, а не обращение к журналу «Продукты»
    'продукты 400',
    '400 такси',
    'отпуск 400', // без предлога и двоеточия — это описание траты
    '400 такси в аэропорт',
  ])('не считается обращением: %s', (text) => {
    expect(pick(text)).toBeNull();
  });

  it('трата уходит в названный журнал, активный не меняется', async () => {
    const found = s.pickRoom('в отпуск: 400 такси', await s.listRooms(app, user.id))!;
    const res = await s.addFromText(app, found.room, user, found.rest);
    expect(res.status === 'ok' && res.ops[0]).toMatchObject({ roomId: trip.id, amount: 40000, description: 'такси' });
    expect((await s.ensureActiveRoom(app, user)).id).toBe(personal.id);
  });
});

describe('перенос траты', () => {
  it('переезжает в текущий период другого журнала с той же категорией', async () => {
    const res = await s.addFromText(app, personal, user, '400 такси');
    if (res.status !== 'ok') throw new Error(res.status);
    const transport = (await s.listCategories(app, personal.id)).find((c) => c.name === 'Транспорт')!;
    const op = (await s.setCategory(app, res.ops[0]!, transport.id))!;

    const moved = (await s.moveOperation(app, op, trip))!;
    expect(moved).toMatchObject({ roomId: trip.id, category: { name: 'Транспорт' } });
    expect(moved.periodId).toBe((await s.currentPeriod(app, trip.id))!.id);
    expect((await s.periodStats(app, (await s.currentPeriod(app, personal.id))!.id)).total).toBe(0);
  });

  it('в журнал с закончившимся сроком перенести нельзя', async () => {
    const res = await s.addFromText(app, personal, user, '400 такси');
    if (res.status !== 'ok') throw new Error(res.status);
    const period = (await s.currentPeriod(app, trip.id))!;
    await s.closeDuePeriods(app, period.endsAt);
    expect(await s.moveOperation(app, res.ops[0]!, trip)).toBeNull();
  });
});
