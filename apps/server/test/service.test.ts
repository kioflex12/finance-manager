import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import type { ExpenseParser, ParseInput } from '../src/core/llm.js';
import * as s from '../src/core/service.js';

let app: s.App;
let llmCalls: ParseInput[];

const fakeLlm: ExpenseParser = {
  async parse(input) {
    llmCalls.push(input);
    return [
      { amount: 400, description: 'продукты', category: 'Продукты' },
      { amount: 250, description: 'такси', category: 'Транспорт' },
    ];
  },
  async categorize(input) {
    llmCalls.push(input);
    return input.text === 'такси' ? 'Транспорт' : 'Нет такой';
  },
};

beforeEach(async () => {
  llmCalls = [];
  app = { db: await openDb(), llm: fakeLlm };
});

async function setup() {
  const user = await s.ensureUser(app, { id: 1, name: 'Костя' });
  const room = await s.ensureActiveRoom(app, user);
  return { user, room };
}

describe('запись трат', () => {
  it('первая трата записывается сразу, категория дозаполняется и запоминается', async () => {
    const { user, room } = await setup();

    const first = await s.addFromText(app, room, user, '250 такси');
    if (first.status !== 'ok') throw new Error(first.status);
    expect(first.ops[0]).toMatchObject({ amount: 25000, description: 'такси', category: null });
    expect(llmCalls).toHaveLength(0);

    const done = await s.categorizePending(app, first.pendingOpId!);
    expect(done?.category?.name).toBe('Транспорт');

    const second = await s.addFromText(app, room, user, 'такси 300');
    if (second.status !== 'ok') throw new Error(second.status);
    expect(second.pendingOpId).toBeUndefined();
    expect(second.ops[0]?.category?.name).toBe('Транспорт');
    expect(llmCalls).toHaveLength(1);
  });

  it('исправление категории применяется к следующим таким же тратам и не затирается моделью', async () => {
    const { user, room } = await setup();
    const categories = await s.listCategories(app, room.id);
    const fun = categories.find((c) => c.name === 'Развлечения')!;

    const first = await s.addFromText(app, room, user, '250 такси');
    if (first.status !== 'ok') throw new Error(first.status);
    await s.categorizePending(app, first.pendingOpId!);
    await s.setCategory(app, first.ops[0]!, fun.id);

    const multi = await s.addFromText(app, room, user, '400 продукты и 250 такси');
    if (multi.status !== 'ok') throw new Error(multi.status);
    expect(multi.ops.map((o) => o.category?.name)).toEqual(['Продукты', 'Развлечения']);
  });

  it('неизвестная категория от модели превращается в «Другое»', async () => {
    const { user, room } = await setup();
    const res = await s.addFromText(app, room, user, '100 штука');
    if (res.status !== 'ok') throw new Error(res.status);
    expect((await s.categorizePending(app, res.pendingOpId!))?.category?.name).toBe('Другое');
  });

  it('без LLM сложный текст не понят, а простой записывается', async () => {
    app.llm = null;
    const { user, room } = await setup();
    expect((await s.addFromText(app, room, user, 'четыреста на продукты')).status).toBe('not_understood');
    expect((await s.addFromText(app, room, user, '400 продукты')).status).toBe('ok');
  });
});

describe('периоды', () => {
  it('месячный период — календарный месяц по времени комнаты', () => {
    const { start, end } = s.periodBounds(
      { periodKind: 'month', periodDays: 30, tzOffsetMin: 180 },
      new Date('2026-10-31T22:30:00Z'), // в Москве уже 1 ноября
    );
    expect(start.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T21:00:00.000Z');
  });

  it('по окончании срока период закрывается со сводкой и продлевается', async () => {
    const { user, room } = await setup();
    await s.addFromText(app, room, user, '400 продукты');
    const period = (await s.currentPeriod(app, room.id))!;

    expect(await s.closeDuePeriods(app, new Date(period.endsAt.getTime() - 1))).toHaveLength(0);

    const [closed] = await s.closeDuePeriods(app, period.endsAt);
    expect(closed).toMatchObject({ renewed: true, chatIds: ['1'], stats: { total: 40000, count: 1 }, previous: null });

    const next = (await s.currentPeriod(app, room.id))!;
    expect(next.id).not.toBe(period.id);
    expect(next.startsAt).toEqual(period.endsAt);
    expect(await s.closeDuePeriods(app, period.endsAt)).toHaveLength(0);
  });

  it('комната на срок без автопродления ждёт ручного запуска нового периода', async () => {
    const { user } = await setup();
    const now = new Date('2026-10-12T10:00:00Z');
    const trip = await s.createRoom(app, user, { name: 'Отпуск', periodKind: 'days', periodDays: 10, autoRenew: false }, now);

    const closed = await s.closeDuePeriods(app, new Date('2026-10-22T10:00:00Z'));
    expect(closed.find((c) => c.room.id === trip.id)).toMatchObject({ renewed: false });
    expect((await s.addFromText(app, trip, user, '400 продукты')).status).toBe('no_period');

    await s.startNewPeriod(app, trip, new Date('2026-10-23T10:00:00Z'));
    expect((await s.addFromText(app, trip, user, '400 продукты')).status).toBe('ok');
  });

  it('бюджет: остаток и сумма в день', async () => {
    const { user, room } = await setup();
    const withBudget = await s.updateRoom(app, room.id, { budget: 3000000 });
    await s.addFromText(app, withBudget, user, '10000 продукты');
    const period = (await s.currentPeriod(app, room.id))!;
    const stats = await s.periodStats(app, period.id);
    const tenDaysBeforeEnd = new Date(period.endsAt.getTime() - 10 * 86_400_000);
    expect(s.budgetInfo(withBudget, period, stats.total, tenDaysBeforeEnd)).toEqual({
      budget: 3000000,
      left: 2000000,
      daysLeft: 10,
      perDay: 200000,
    });
  });
});

describe('совместные комнаты', () => {
  it('приглашение по коду добавляет участника, траты видны всем', async () => {
    const { user, room } = await setup();
    const friend = await s.ensureUser(app, { id: 2, name: 'Аня' });
    expect(await s.joinRoom(app, friend, 'нет-такого')).toBeNull();
    expect((await s.joinRoom(app, friend, room.inviteCode))?.id).toBe(room.id);

    await s.addFromText(app, room, user, '400 продукты');
    await s.addFromText(app, room, friend, '600 продукты');
    const stats = await s.periodStats(app, (await s.currentPeriod(app, room.id))!.id);
    expect(stats.total).toBe(100000);
    expect(stats.byMember.map((m) => [m.name, m.total])).toEqual([
      ['Аня', 60000],
      ['Костя', 40000],
    ]);
  });

  it('групповой чат получает одну комнату на всех', async () => {
    const a = await s.ensureUser(app, { id: 1, name: 'Костя' });
    const b = await s.ensureUser(app, { id: 2, name: 'Аня' });
    const room = await s.ensureGroupRoom(app, { id: -100, title: 'Семья' }, a);
    expect((await s.ensureGroupRoom(app, { id: -100, title: 'Семья' }, b)).id).toBe(room.id);
    expect(await s.listMembers(app, room.id)).toHaveLength(2);
  });
});

describe('напоминания', () => {
  it('в 21:00 напоминает один раз тому, кто сегодня ничего не записал', async () => {
    const { user, room } = await setup();
    await s.addFromText(app, room, user, '400 продукты');
    const evening = new Date(Date.now() + 86_400_000);
    evening.setUTCHours(18, 5, 0, 0); // 21:05 МСК завтра
    // период мог кончиться на стыке месяцев — тогда комната уже продлена
    await s.closeDuePeriods(app, evening);

    expect(await s.dueReminders(app, new Date(evening.getTime() - 3_600_000))).toHaveLength(0);
    expect((await s.dueReminders(app, evening)).map((u) => u.tgId)).toEqual(['1']);
    expect(await s.dueReminders(app, evening)).toHaveLength(0);
  });
});
