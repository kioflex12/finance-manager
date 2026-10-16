import { beforeEach, describe, expect, it } from 'vitest';
import type { ExpenseParser } from '../src/core/llm.js';
import * as s from '../src/core/service.js';
import { openDb } from '../src/db.js';

// модель, которая, как в жизни, иногда оставляет подробное название
const llm: ExpenseParser = {
  async parse() {
    return [];
  },
  async categorize(input) {
    const item = input.text.charAt(0).toUpperCase() + input.text.slice(1);
    return { category: 'Развлечения', item };
  },
  async groupItems() {
    return merges;
  },
};

let merges: { from: string; to: string }[] = [];

let app: s.App;
let user: s.User;
let room: s.Room;

beforeEach(async () => {
  app = { db: await openDb(), llm };
  user = await s.ensureUser(app, { id: 1, name: 'Костя' });
  room = await s.ensureActiveRoom(app, user);
});

async function add(text: string) {
  const res = await s.addFromText(app, room, user, text);
  if (res.status !== 'ok') throw new Error(res.status);
  if (res.pendingOpId) await s.categorizePending(app, res.pendingOpId);
}

const items = async () =>
  (await s.listOperations(app, (await s.currentPeriod(app, room.id))!.id)).map((op) => [op.description, op.item]).reverse();

describe('группировка по смыслу', () => {
  it('разновидности переезжают в общую позицию, ответ модели проверяется', async () => {
    for (const text of ['100 напитки', '150 лимонад', '200 кола', '300 сыр', '400 капучино', '500 кофе']) await add(text);
    merges = [
      { from: 'Лимонад', to: 'Напитки' },
      { from: 'Кола', to: 'Напитки' },
      // в категорию не схлопываем
      { from: 'Сыр', to: 'Развлечения' },
      // выдуманные названия игнорируются
      { from: 'Капучино', to: 'Кофейные напитки' },
      // цепочка: Кофе сам уходит в «Напитки», поэтому «Капучино → Кофе» отбрасывается
      { from: 'Кофе', to: 'Напитки' },
      { from: 'Капучино', to: 'Кофе' },
    ];
    expect(await s.groupItemsByMeaning(app, room.id)).toBe(3);
    expect((await items()).map(([, item]) => item)).toEqual(['Напитки', 'Напитки', 'Напитки', 'Сыр', 'Капучино', 'Напитки']);
    merges = [];
  });

  it('новая позиция запускает пересборку журнала в фоне', async () => {
    await add('150 лимонад');
    merges = [{ from: 'Лимонад', to: 'Напитки' }];
    await add('100 напитки');
    await s.flushNewItems(app);
    expect((await items()).map(([, item]) => item)).toEqual(['Напитки', 'Напитки']);
    merges = [];
  });
});

describe('позиции собираются по общему признаку', () => {
  it('containedItem находит существующую позицию внутри описания, целыми словами', () => {
    expect(s.containedItem(['Мафия', 'Кофе'], 'капитанский стол мафия')).toBe('Мафия');
    expect(s.containedItem(['Мафия', 'Капитанский стол'], 'капитанский стол мафия')).toBe('Капитанский стол');
    expect(s.containedItem(['Кофе'], 'кофемашина')).toBeNull();
    expect(s.containedItem(['Ок'], 'ок такси')).toBeNull();
    expect(s.containedItem(['Такси'], 'Такси, до аэропорта!')).toBe('Такси');
  });

  it('подробная трата попадает в уже существующую общую позицию', async () => {
    await add('300 мафия');
    await add('500 капитанский стол мафия');
    expect(await items()).toEqual([
      ['мафия', 'Мафия'],
      ['капитанский стол мафия', 'Мафия'],
    ]);
  });

  it('новая общая позиция забирает записанные раньше подробные', async () => {
    await add('500 капитанский стол мафия');
    await add('200 мафия на выходных');
    expect((await items()).map(([, item]) => item)).toEqual(['Капитанский стол мафия', 'Мафия на выходных']);

    await add('300 мафия');
    expect((await items()).map(([, item]) => item)).toEqual(['Мафия', 'Мафия', 'Мафия']);
    // и правило для подробного описания теперь ведёт в общую позицию
    await add('600 капитанский стол мафия');
    expect((await items()).at(-1)?.[1]).toBe('Мафия');
  });

  it('уже записанные позиции собираются при старте', async () => {
    await add('500 капитанский стол мафия');
    // общую позицию кто-то записал в обход правил (как было до этого изменения)
    await app.db.query("UPDATE operations SET item = 'Мафия' WHERE id = (SELECT MIN(id) FROM operations)");
    await add('100 кофе');
    await add('150 кофе с собой');
    await app.db.query("UPDATE operations SET item = 'Кофе с собой' WHERE description = 'кофе с собой'");

    await s.regroupItems(app);
    expect((await items()).map(([, item]) => item)).toEqual(['Мафия', 'Кофе', 'Кофе']);
    await s.regroupItems(app);
    expect((await items()).map(([, item]) => item)).toEqual(['Мафия', 'Кофе', 'Кофе']);
  });
});
