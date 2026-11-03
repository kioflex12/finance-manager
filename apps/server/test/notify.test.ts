import { beforeEach, describe, expect, it } from 'vitest';
import { notifyExpenseAdded } from '../src/core/notify.js';
import * as s from '../src/core/service.js';
import { openDb } from '../src/db.js';

let app: s.App;
let sent: { chatId: string; text: string }[];
let kostya: s.User;
let masha: s.User;
let room: s.Room;

beforeEach(async () => {
  sent = [];
  app = {
    db: await openDb(),
    llm: null,
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  };
  kostya = await s.ensureUser(app, { id: 1, name: 'Костя' });
  masha = await s.ensureUser(app, { id: 2, name: 'Маша' });
  room = await s.createRoom(app, kostya, { name: 'Семья', periodKind: 'month', autoRenew: true });
  await s.joinRoom(app, masha, room.inviteCode);
});

async function add(user: s.User, text: string): Promise<s.Operation> {
  const res = await s.addFromText(app, room, user, text);
  if (res.status !== 'ok') throw new Error(res.status);
  if (res.pendingOpId) await s.categorizePending(app, res.pendingOpId);
  return (await s.getOperation(app, res.ops[0]!.id))!;
}

async function shiftCreated(opId: number, hoursAgo: number): Promise<void> {
  await app.db.query('UPDATE operations SET created_at = created_at - make_interval(hours => $2) WHERE id = $1', [opId, hoursAgo]);
}

describe('уведомления участников общего журнала', () => {
  it('остальные участники получают сообщение о трате, автор — нет', async () => {
    const op = await add(kostya, '300 вода');
    await notifyExpenseAdded(app, room, kostya, [op]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe('2');
    expect(sent[0]!.text).toContain('Костя');
    expect(sent[0]!.text).toContain('Семья');
    expect(sent[0]!.text).toContain('300 ₽');
    expect(sent[0]!.text).toContain('За период');
  });

  it('несколько трат приходят одним сообщением', async () => {
    const ops = [await add(kostya, '300 вода'), await add(kostya, '200 хлеб')];
    await notifyExpenseAdded(app, room, kostya, ops);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('300 ₽');
    expect(sent[0]!.text).toContain('200 ₽');
  });

  it('в журнал группового чата рассылка не делается — запись и так видна в чате', async () => {
    const groupRoom = await s.createRoom(app, kostya, {
      name: 'Чат',
      periodKind: 'month',
      autoRenew: true,
      tgChatId: '-100123',
    });
    await s.joinRoom(app, masha, groupRoom.inviteCode);
    const res = await s.addFromText(app, groupRoom, kostya, '300 вода');
    if (res.status !== 'ok') throw new Error(res.status);
    await notifyExpenseAdded(app, groupRoom, kostya, res.ops);
    expect(sent).toHaveLength(0);
  });

  it('личный журнал с одним участником не рассылает ничего', async () => {
    const solo = await s.createRoom(app, kostya, { name: 'Личный', periodKind: 'month', autoRenew: true });
    const res = await s.addFromText(app, solo, kostya, '300 вода');
    if (res.status !== 'ok') throw new Error(res.status);
    await notifyExpenseAdded(app, solo, kostya, res.ops);
    expect(sent).toHaveLength(0);
  });
});

describe('защита от дублей', () => {
  it('та же сумма и описание от другого участника — дубль', async () => {
    await add(kostya, '300 вода');
    const second = await add(masha, '300 вода');
    const dups = await s.findDuplicates(app, second);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.userName).toBe('Костя');
  });

  it('общее слово с другим окончанием: «вода» и «вода газированная» — дубль', async () => {
    await add(kostya, '300 вода газированная');
    const second = await add(masha, '300 вода');
    expect(await s.findDuplicates(app, second)).toHaveLength(1);
  });

  it('разные слова, но та же сумма и категория почти одновременно — дубль', async () => {
    await add(kostya, '300 напитки');
    const second = await add(masha, '300 вода');
    expect(await s.findDuplicates(app, second)).toHaveLength(1);
  });

  it('разные слова и категории — не дубль', async () => {
    const first = await add(kostya, '300 напитки');
    const fun = (await s.listCategories(app, room.id)).find((c) => c.name === 'Развлечения')!;
    await s.setCategory(app, first, fun.id);
    const second = await add(masha, '300 вода');
    expect(await s.findDuplicates(app, second)).toHaveLength(0);
  });

  it('та же категория, но записи далеко по времени и разные слова — не дубль', async () => {
    const first = await add(kostya, '300 обед');
    await shiftCreated(first.id, 3);
    const second = await add(masha, '300 ужин');
    expect(await s.findDuplicates(app, second)).toHaveLength(0);
  });

  it('другая сумма — не дубль', async () => {
    await add(kostya, '300 вода');
    const second = await add(masha, '400 вода');
    expect(await s.findDuplicates(app, second)).toHaveLength(0);
  });

  it('такая же трата позавчера — не дубль', async () => {
    const first = await add(kostya, '300 вода');
    await shiftCreated(first.id, 25);
    const second = await add(masha, '300 вода');
    expect(await s.findDuplicates(app, second)).toHaveLength(0);
  });
});
