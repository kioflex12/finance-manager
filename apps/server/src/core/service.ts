import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import type { ExpenseParser, ParseInput } from './llm.js';
import { notifyRoom } from './events.js';
import { quickParse, ruleKey } from './parse.js';

export interface App {
  db: Db;
  llm: ExpenseParser | null;
  /** отправка сообщения в Telegram от имени бота; нет, если бот не запущен */
  send?: (chatId: string, text: string) => Promise<void>;
}

export interface User {
  id: number;
  tgId: string;
  name: string;
  activeRoomId: number | null;
  reminders: boolean;
  blocked: boolean;
}

export interface Room {
  id: number;
  name: string;
  ownerId: number;
  tgChatId: string | null;
  periodKind: 'month' | 'days';
  periodDays: number;
  autoRenew: boolean;
  budget: number | null;
  inviteCode: string;
  tzOffsetMin: number;
  emoji: string | null;
  color: string;
}

export interface Period {
  id: number;
  roomId: number;
  startsAt: Date;
  endsAt: Date;
  closedAt: Date | null;
}

export interface Category {
  id: number;
  name: string;
  emoji: string;
}

export interface Operation {
  id: number;
  roomId: number;
  periodId: number;
  userId: number;
  userName: string;
  amount: number;
  description: string;
  /** позиция: общее название для одинаковых по сути трат («кофе» для «кофеёчек») */
  item: string;
  category: Category | null;
  createdAt: Date;
}

export interface Stats {
  total: number;
  count: number;
  byCategory: { category: Category | null; total: number; count: number }[];
  byMember: { userId: number; name: string; total: number }[];
}

export interface BudgetInfo {
  budget: number;
  left: number;
  daysLeft: number;
  /** сколько можно тратить в день, чтобы уложиться (целые рубли); 0 при перерасходе */
  perDay: number;
}

const USER = `id, tg_id AS "tgId", name, active_room_id AS "activeRoomId", reminders, blocked`;
const ROOM = `id, name, owner_id AS "ownerId", tg_chat_id AS "tgChatId", period_kind AS "periodKind",
  period_days AS "periodDays", auto_renew AS "autoRenew", budget, invite_code AS "inviteCode",
  tz_offset_min AS "tzOffsetMin", emoji, color`;
const PERIOD = `id, room_id AS "roomId", starts_at AS "startsAt", ends_at AS "endsAt", closed_at AS "closedAt"`;
const OPERATION = `o.id, o.room_id AS "roomId", o.period_id AS "periodId", o.user_id AS "userId", o.item,
  u.name AS "userName", o.amount, o.description, o.created_at AS "createdAt",
  c.id AS "categoryId", c.name AS "categoryName", c.emoji AS "categoryEmoji"`;
const OPERATION_FROM = `operations o JOIN users u ON u.id = o.user_id LEFT JOIN categories c ON c.id = o.category_id`;

const OTHER = 'Другое';
const NO_DESCRIPTION = 'без описания';
const DEFAULT_CATEGORIES: [string, string][] = [
  ['Продукты', '🛒'],
  ['Кафе и рестораны', '🍽'],
  ['Транспорт', '🚕'],
  ['Дом и связь', '🏠'],
  ['Здоровье', '💊'],
  ['Одежда', '👕'],
  ['Развлечения', '🎬'],
  ['Подписки', '🔁'],
  ['Подарки', '🎁'],
  [OTHER, '📦'],
];

const DAY = 86_400_000;

// ---------- пользователи ----------

export async function ensureUser(app: App, tg: { id: number | string; name: string }): Promise<User> {
  const [user] = await app.db.query<User>(
    `INSERT INTO users (tg_id, name) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now() RETURNING ${USER}`,
    [String(tg.id), tg.name || 'Без имени'],
  );
  return user!;
}

export async function setActiveRoom(app: App, user: User, roomId: number): Promise<void> {
  await app.db.query('UPDATE users SET active_room_id = $1 WHERE id = $2', [roomId, user.id]);
  user.activeRoomId = roomId;
}

export async function setReminders(app: App, userId: number, on: boolean): Promise<void> {
  await app.db.query('UPDATE users SET reminders = $1 WHERE id = $2', [on, userId]);
}

// ---------- комнаты ----------

export interface RoomInput {
  name: string;
  periodKind: 'month' | 'days';
  periodDays?: number;
  autoRenew: boolean;
  budget?: number | null;
  tgChatId?: string;
}

export async function createRoom(app: App, owner: User, input: RoomInput, now = new Date()): Promise<Room> {
  const [room] = await app.db.query<Room>(
    `INSERT INTO rooms (name, owner_id, tg_chat_id, period_kind, period_days, auto_renew, budget, invite_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${ROOM}`,
    [
      input.name.trim().slice(0, 64) || 'Журнал',
      owner.id,
      input.tgChatId ?? null,
      input.periodKind,
      clampDays(input.periodDays),
      input.autoRenew,
      input.budget ?? null,
      randomBytes(6).toString('base64url'),
    ],
  );
  for (const [name, emoji] of DEFAULT_CATEGORIES) {
    await app.db.query('INSERT INTO categories (room_id, name, emoji) VALUES ($1, $2, $3)', [room!.id, name, emoji]);
  }
  await addMember(app, room!.id, owner.id);
  await openPeriod(app, room!, now);
  return room!;
}

function clampDays(days: number | undefined): number {
  return Math.min(366, Math.max(1, Math.round(days ?? 30)));
}

export const ROOM_COLORS = ['violet', 'blue', 'teal', 'green', 'orange', 'pink', 'red', 'graphite'] as const;
export type RoomColor = (typeof ROOM_COLORS)[number];

export interface RoomPatch {
  name?: string;
  budget?: number | null;
  autoRenew?: boolean;
  /** тип и длина периода меняются со следующего периода, текущий идёт до своего конца */
  periodKind?: 'month' | 'days';
  periodDays?: number;
  /** null — вернуть аватар-букву */
  emoji?: string | null;
  color?: RoomColor;
}

export async function updateRoom(app: App, roomId: number, patch: RoomPatch): Promise<Room> {
  const [room] = await app.db.query<Room>(
    `UPDATE rooms SET
       name = COALESCE($2, name),
       budget = CASE WHEN $3 THEN $4::integer ELSE budget END,
       auto_renew = COALESCE($5, auto_renew),
       emoji = CASE WHEN $6 THEN $7::text ELSE emoji END,
       color = COALESCE($8, color),
       period_kind = COALESCE($9, period_kind),
       period_days = COALESCE($10, period_days)
     WHERE id = $1 RETURNING ${ROOM}`,
    [
      roomId,
      patch.name?.trim().slice(0, 64) || null,
      patch.budget !== undefined,
      patch.budget ?? null,
      patch.autoRenew ?? null,
      patch.emoji !== undefined,
      patch.emoji?.trim().slice(0, 16) || null,
      patch.color ?? null,
      patch.periodKind ?? null,
      patch.periodDays === undefined ? null : clampDays(patch.periodDays),
    ],
  );
  notifyRoom(roomId);
  return room!;
}

export async function deleteRoom(app: App, roomId: number): Promise<void> {
  await app.db.query('UPDATE users SET active_room_id = NULL WHERE active_room_id = $1', [roomId]);
  await app.db.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  notifyRoom(roomId);
}

export async function leaveRoom(app: App, roomId: number, userId: number): Promise<void> {
  await app.db.query('UPDATE users SET active_room_id = NULL WHERE id = $2 AND active_room_id = $1', [roomId, userId]);
  await app.db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  notifyRoom(roomId);
}

/** Удаляет все траты периода; выученные категории и позиции остаются. */
export async function clearPeriod(app: App, periodId: number): Promise<void> {
  const [period] = await app.db.query<{ roomId: number }>('SELECT room_id AS "roomId" FROM periods WHERE id = $1', [periodId]);
  await app.db.query('DELETE FROM operations WHERE period_id = $1', [periodId]);
  if (period) notifyRoom(period.roomId);
}

export async function getRoom(app: App, roomId: number): Promise<Room | null> {
  const [room] = await app.db.query<Room>(`SELECT ${ROOM} FROM rooms WHERE id = $1`, [roomId]);
  return room ?? null;
}

export async function listRooms(app: App, userId: number): Promise<Room[]> {
  return app.db.query<Room>(
    `SELECT ${ROOM} FROM rooms WHERE id IN (SELECT room_id FROM room_members WHERE user_id = $1) ORDER BY id`,
    [userId],
  );
}

export async function isMember(app: App, roomId: number, userId: number): Promise<boolean> {
  const rows = await app.db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  return rows.length > 0;
}

async function addMember(app: App, roomId: number, userId: number): Promise<void> {
  const added = await app.db.query(
    'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING room_id',
    [roomId, userId],
  );
  if (added.length) notifyRoom(roomId);
}

export async function listMembers(app: App, roomId: number): Promise<User[]> {
  return app.db.query<User>(
    `SELECT ${USER} FROM users WHERE id IN (SELECT user_id FROM room_members WHERE room_id = $1) ORDER BY id`,
    [roomId],
  );
}

/** Активная комната пользователя; при первом входе создаёт личную месячную. */
export async function ensureActiveRoom(app: App, user: User): Promise<Room> {
  if (user.activeRoomId) {
    const room = await getRoom(app, user.activeRoomId);
    if (room && (await isMember(app, room.id, user.id))) return room;
  }
  const room =
    (await listRooms(app, user.id))[0] ??
    (await createRoom(app, user, { name: 'Личные траты', periodKind: 'month', autoRenew: true }));
  await setActiveRoom(app, user, room.id);
  return room;
}

/** Комната группового чата: создаётся при первом обращении, пишущие становятся участниками. */
export async function ensureGroupRoom(app: App, chat: { id: number | string; title: string }, user: User): Promise<Room> {
  const [found] = await app.db.query<Room>(`SELECT ${ROOM} FROM rooms WHERE tg_chat_id = $1`, [String(chat.id)]);
  const room =
    found ??
    (await createRoom(app, user, { name: chat.title, periodKind: 'month', autoRenew: true, tgChatId: String(chat.id) }));
  await addMember(app, room.id, user.id);
  return room;
}

export async function joinRoom(app: App, user: User, inviteCode: string): Promise<Room | null> {
  const [room] = await app.db.query<Room>(`SELECT ${ROOM} FROM rooms WHERE invite_code = $1`, [inviteCode]);
  if (!room) return null;
  await addMember(app, room.id, user.id);
  await setActiveRoom(app, user, room.id);
  return room;
}

/** Слово названия с допуском на падеж: «отпуск» найдётся и в «отпуске», «поездка» — в «поездку». */
function inflected(word: string): string {
  const stem = word.length > 4 ? word.slice(0, -2) : word.length > 3 ? word.slice(0, -1) : word;
  return `${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{L}{0,3}`;
}

/**
 * Журнал, явно названный в сообщении: «отпуск: 400 такси», «в отпуск 400 такси», «#отпуск 400 такси»,
 * «400 такси в отпуск». Нужен предлог, двоеточие или решётка — иначе «400 продукты» ушло бы в журнал «Продукты».
 * Возвращает журнал и текст траты без его названия.
 */
export function pickRoom(text: string, rooms: Room[]): { room: Room; rest: string } | null {
  const source = text.trim();
  const plain = source.toLowerCase().replace(/ё/g, 'е');
  const firstWords = rooms.map((r) => ruleKey(r.name).split(' ')[0] ?? '');

  // длинные названия раньше: «Отпуск в Сочи» не должен проиграть журналу «Отпуск»
  const candidates = rooms
    .map((room, i) => {
      const words = ruleKey(room.name).split(' ').filter(Boolean);
      const first = words[0] ?? '';
      // короткое обращение по первому слову — только если оно не общее с другим журналом
      const short = words.length > 1 && first.length >= 4 && firstWords.indexOf(first) === i && firstWords.lastIndexOf(first) === i;
      return { room, names: [words.map(inflected).join('\\s+'), ...(short ? [inflected(first)] : [])], length: room.name.length };
    })
    .filter((c) => c.names[0])
    .sort((a, b) => b.length - a.length);

  for (const { room, names } of candidates) {
    for (const name of names) {
      const head = new RegExp(
        `^(?:(?:запиши|записать|добавь)\\s+)?(?:(?<prep>в|во)\\s+|(?<hash>#))?${name}(?<colon>\\s*[:—-])?\\s+(?<rest>.+)$`,
        'du',
      ).exec(plain);
      if (head?.groups && (head.groups.prep || head.groups.hash || head.groups.colon)) {
        return { room, rest: source.slice(head.indices!.groups!.rest![0]) };
      }
      const tail = new RegExp(`^(?<rest>.+?)\\s+(?:в|во)\\s+${name}[.!]?$`, 'du').exec(plain);
      if (tail) return { room, rest: source.slice(0, tail.indices!.groups!.rest![1]) };
    }
  }
  return null;
}

export async function listCategories(app: App, roomId: number): Promise<Category[]> {
  return app.db.query<Category>('SELECT id, name, emoji FROM categories WHERE room_id = $1 ORDER BY id', [roomId]);
}

// ---------- периоды ----------

export function periodBounds(room: Pick<Room, 'periodKind' | 'periodDays' | 'tzOffsetMin'>, from: Date): { start: Date; end: Date } {
  if (room.periodKind === 'days') {
    return { start: from, end: new Date(from.getTime() + room.periodDays * DAY) };
  }
  // календарный месяц в часовом поясе комнаты
  const offset = room.tzOffsetMin * 60_000;
  const local = new Date(from.getTime() + offset);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1) - offset), end: new Date(Date.UTC(y, m + 1, 1) - offset) };
}

async function openPeriod(app: App, room: Room, from: Date): Promise<Period> {
  const { start, end } = periodBounds(room, from);
  const [period] = await app.db.query<Period>(
    `INSERT INTO periods (room_id, starts_at, ends_at) VALUES ($1, $2::timestamptz, $3::timestamptz) RETURNING ${PERIOD}`,
    [room.id, start.toISOString(), end.toISOString()],
  );
  notifyRoom(room.id);
  return period!;
}

export async function currentPeriod(app: App, roomId: number): Promise<Period | null> {
  const [period] = await app.db.query<Period>(
    `SELECT ${PERIOD} FROM periods WHERE room_id = $1 AND closed_at IS NULL ORDER BY id DESC LIMIT 1`,
    [roomId],
  );
  return period ?? null;
}

export async function getPeriod(app: App, periodId: number): Promise<Period | null> {
  const [period] = await app.db.query<Period>(`SELECT ${PERIOD} FROM periods WHERE id = $1`, [periodId]);
  return period ?? null;
}

export async function listPeriods(app: App, roomId: number): Promise<(Period & { total: number })[]> {
  return app.db.query(
    `SELECT ${PERIOD}, (SELECT COALESCE(SUM(amount), 0)::float8 FROM operations WHERE period_id = periods.id) AS total
     FROM periods WHERE room_id = $1 ORDER BY id DESC`,
    [roomId],
  );
}

/** Новый период для комнаты без автопродления; если открытый уже есть — возвращает его. */
export async function startNewPeriod(app: App, room: Room, now = new Date()): Promise<Period> {
  return (await currentPeriod(app, room.id)) ?? (await openPeriod(app, room, now));
}

export interface ClosedPeriod {
  room: Room;
  period: Period;
  stats: Stats;
  previous: Stats | null;
  renewed: boolean;
  /** куда слать сводку: чат комнаты либо личные чаты участников */
  chatIds: string[];
}

/** Закрывает истёкшие периоды и продлевает комнаты с автопродлением. */
export async function closeDuePeriods(app: App, now = new Date()): Promise<ClosedPeriod[]> {
  const due = await app.db.query<Period>(
    `UPDATE periods SET closed_at = $1::timestamptz WHERE closed_at IS NULL AND ends_at <= $1::timestamptz RETURNING ${PERIOD}`,
    [now.toISOString()],
  );
  const result: ClosedPeriod[] = [];
  for (const period of due) {
    notifyRoom(period.roomId);
    const room = await getRoom(app, period.roomId);
    if (!room) continue;
    const [prev] = await app.db.query<{ id: number }>(
      'SELECT id FROM periods WHERE room_id = $1 AND id < $2 ORDER BY id DESC LIMIT 1',
      [room.id, period.id],
    );
    if (room.autoRenew) {
      // после простоя сервера следующий период мог бы оказаться уже истёкшим — тогда начинаем от «сейчас»
      const next = periodBounds(room, period.endsAt);
      await openPeriod(app, room, next.end > now ? period.endsAt : now);
    }
    // заблокированным пользователям бот не пишет
    const chatIds = room.tgChatId ? [room.tgChatId] : (await listMembers(app, room.id)).filter((u) => !u.blocked).map((u) => u.tgId);
    result.push({
      room,
      period,
      stats: await periodStats(app, period.id),
      previous: prev ? await periodStats(app, prev.id) : null,
      renewed: room.autoRenew,
      chatIds,
    });
  }
  return result;
}

export async function periodStats(app: App, periodId: number): Promise<Stats> {
  const cats = await app.db.query<{ id: number | null; name: string | null; emoji: string | null; total: number; count: number }>(
    `SELECT c.id, c.name, c.emoji, SUM(o.amount)::float8 AS total, COUNT(*)::int AS count
     FROM operations o LEFT JOIN categories c ON c.id = o.category_id
     WHERE o.period_id = $1 GROUP BY c.id, c.name, c.emoji ORDER BY total DESC`,
    [periodId],
  );
  const byMember = await app.db.query<{ userId: number; name: string; total: number }>(
    `SELECT u.id AS "userId", u.name, SUM(o.amount)::float8 AS total
     FROM operations o JOIN users u ON u.id = o.user_id
     WHERE o.period_id = $1 GROUP BY u.id, u.name ORDER BY total DESC`,
    [periodId],
  );
  return {
    total: cats.reduce((s, c) => s + c.total, 0),
    count: cats.reduce((s, c) => s + c.count, 0),
    byCategory: cats.map((c) => ({
      category: c.id === null ? null : { id: c.id, name: c.name!, emoji: c.emoji! },
      total: c.total,
      count: c.count,
    })),
    byMember,
  };
}

export function budgetInfo(room: Room, period: Period, total: number, now = new Date()): BudgetInfo | null {
  if (!room.budget) return null;
  const left = room.budget - total;
  const daysLeft = Math.max(1, Math.ceil((period.endsAt.getTime() - now.getTime()) / DAY));
  return { budget: room.budget, left, daysLeft, perDay: left > 0 ? Math.floor(left / daysLeft / 100) * 100 : 0 };
}

// ---------- операции ----------

type OperationRow = Omit<Operation, 'category'> & {
  categoryId: number | null;
  categoryName: string | null;
  categoryEmoji: string | null;
};

function toOperation({ categoryId, categoryName, categoryEmoji, ...op }: OperationRow): Operation {
  return { ...op, category: categoryId === null ? null : { id: categoryId, name: categoryName!, emoji: categoryEmoji! } };
}

export async function getOperation(app: App, opId: number): Promise<Operation | null> {
  const [row] = await app.db.query<OperationRow>(`SELECT ${OPERATION} FROM ${OPERATION_FROM} WHERE o.id = $1`, [opId]);
  return row ? toOperation(row) : null;
}

export async function listOperations(app: App, periodId: number, categoryId?: number | null): Promise<Operation[]> {
  const filter =
    categoryId === undefined ? '' : categoryId === null ? 'AND o.category_id IS NULL' : 'AND o.category_id = $2';
  const rows = await app.db.query<OperationRow>(
    `SELECT ${OPERATION} FROM ${OPERATION_FROM} WHERE o.period_id = $1 ${filter} ORDER BY o.id DESC`,
    categoryId ? [periodId, categoryId] : [periodId],
  );
  return rows.map(toOperation);
}

async function insertOperation(
  app: App,
  period: Period,
  user: User,
  amount: number,
  description: string,
  categoryId: number | null,
  item: string,
): Promise<Operation> {
  const [row] = await app.db.query<{ id: number }>(
    `INSERT INTO operations (room_id, period_id, user_id, amount, description, category_id, item)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [period.roomId, period.id, user.id, amount, description.slice(0, 200), categoryId, item],
  );
  notifyRoom(period.roomId);
  return (await getOperation(app, row!.id))!;
}

/**
 * Название траты в едином виде — так она показывается везде: с большой буквы, без хвостовой пунктуации
 * и лишних пробелов. Регистр внутри сохраняется, чтобы бренды оставались как есть («Яндекс Плюс»).
 */
export function displayName(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().replace(/[.,;:!?…]+$/u, '').trim().slice(0, 60);
  return clean ? clean.charAt(0).toLocaleUpperCase('ru') + clean.slice(1) : '';
}

/** Позиция: название от модели («кофеёчек» → «Кофе»), а без неё — само описание в едином виде. */
function toItem(item: string | null | undefined, description: string): string {
  return displayName(item ?? '') || displayName(description) || displayName(NO_DESCRIPTION);
}

async function findRule(app: App, roomId: number, description: string): Promise<{ categoryId: number; item: string | null } | null> {
  const key = ruleKey(description);
  if (!key) return null;
  const [rule] = await app.db.query<{ categoryId: number; item: string | null }>(
    'SELECT category_id AS "categoryId", item FROM rules WHERE room_id = $1 AND key = $2',
    [roomId, key],
  );
  return rule ?? null;
}

async function saveRule(
  app: App,
  roomId: number,
  description: string,
  categoryId: number,
  item: string,
  byUser: boolean,
): Promise<void> {
  const key = ruleKey(description);
  if (!key) return;
  await app.db.query(
    `INSERT INTO rules (room_id, key, category_id, item, by_user) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (room_id, key) DO UPDATE SET category_id = EXCLUDED.category_id, item = EXCLUDED.item, by_user = EXCLUDED.by_user
     WHERE EXCLUDED.by_user OR NOT rules.by_user`,
    [roomId, key, categoryId, item, byUser],
  );
}

/** Вызов LLM с категориями и выученными правилами комнаты; null — LLM нет или он не ответил. */
async function askLlm<T>(
  app: App,
  roomId: number,
  text: string,
  categories: Category[],
  call: (llm: ExpenseParser, input: ParseInput) => Promise<T>,
): Promise<T | null> {
  if (!app.llm) return null;
  const hints = await app.db.query<{ description: string; category: string }>(
    `SELECT r.key AS description, c.name AS category FROM rules r JOIN categories c ON c.id = r.category_id
     WHERE r.room_id = $1 ORDER BY r.by_user DESC LIMIT 40`,
    [roomId],
  );
  const items = await app.db.query<{ item: string }>(
    'SELECT item FROM operations WHERE room_id = $1 GROUP BY item ORDER BY COUNT(*) DESC, item LIMIT 60',
    [roomId],
  );
  try {
    return await call(app.llm, { text, categories: categories.map((c) => c.name), hints, items: items.map((i) => i.item) });
  } catch (err) {
    console.error('LLM failed', err);
    return null;
  }
}

export type AddResult =
  | { status: 'ok'; ops: Operation[]; /** записана сразу, категорию нужно дозаполнить через categorizePending */ pendingOpId?: number }
  | { status: 'no_period' }
  | { status: 'not_understood' };

/**
 * Записывает траты из текста. Простое сообщение с одной суммой сохраняется сразу, без ожидания LLM:
 * категория берётся из правил, а если правила нет — остаётся пустой до categorizePending.
 */
export async function addFromText(app: App, room: Room, user: User, text: string): Promise<AddResult> {
  const period = await currentPeriod(app, room.id);
  if (!period) return { status: 'no_period' };
  const categories = await listCategories(app, room.id);
  const other = categories.find((c) => c.name === OTHER) ?? null;

  const quick = quickParse(text);
  if (quick) {
    const rule = quick.description ? await findRule(app, room.id, quick.description) : null;
    const categoryId = quick.description ? (rule?.categoryId ?? null) : (other?.id ?? null);
    const item = toItem(rule?.item, quick.description);
    const op = await insertOperation(app, period, user, quick.amount, quick.description || NO_DESCRIPTION, categoryId, item);
    return categoryId === null ? { status: 'ok', ops: [op], pendingOpId: op.id } : { status: 'ok', ops: [op] };
  }

  const parsed = await askLlm(app, room.id, text, categories, (llm, input) => llm.parse(input));
  if (!parsed?.length) return { status: 'not_understood' };
  const ops: Operation[] = [];
  for (const found of parsed) {
    const amount = Math.round(found.amount * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_000_000_000) continue;
    const category = categories.find((c) => c.name === found.category) ?? other;
    // выученное правило сильнее догадки модели
    const rule = await findRule(app, room.id, found.description);
    const item = toItem(rule?.item ?? found.item, found.description);
    ops.push(
      await insertOperation(app, period, user, amount, found.description || NO_DESCRIPTION, rule?.categoryId ?? category?.id ?? null, item),
    );
    if (!rule && category && category !== other) await saveRule(app, room.id, found.description, category.id, item, false);
  }
  return ops.length ? { status: 'ok', ops } : { status: 'not_understood' };
}

/** Подбирает категорию операции, записанной без неё. Без LLM или при ошибке — «Другое». */
export async function categorizePending(app: App, opId: number): Promise<Operation | null> {
  const op = await getOperation(app, opId);
  if (!op || op.category) return op;
  const categories = await listCategories(app, op.roomId);
  const other = categories.find((c) => c.name === OTHER) ?? null;
  const answer = await askLlm(app, op.roomId, op.description, categories, (llm, input) => llm.categorize(input));
  const guess = categories.find((c) => c.name === answer?.category);
  const category = guess ?? other;
  if (!category) return op;
  const item = toItem(answer?.item, op.description);
  await app.db.query('UPDATE operations SET item = $1 WHERE id = $2', [item, opId]);
  // пользователь мог успеть выбрать категорию сам, пока думала модель
  await app.db.query('UPDATE operations SET category_id = $1 WHERE id = $2 AND category_id IS NULL', [category.id, opId]);
  if (guess && guess !== other) await saveRule(app, op.roomId, op.description, guess.id, item, false);
  notifyRoom(op.roomId);
  return getOperation(app, opId);
}

/** Исправление категории пользователем: запоминается правилом для таких же описаний. */
export async function setCategory(app: App, op: Operation, categoryId: number): Promise<Operation | null> {
  const [category] = await app.db.query('SELECT 1 FROM categories WHERE id = $1 AND room_id = $2', [categoryId, op.roomId]);
  if (!category) return null;
  await app.db.query('UPDATE operations SET category_id = $1 WHERE id = $2', [categoryId, op.id]);
  await saveRule(app, op.roomId, op.description, categoryId, op.item, true);
  notifyRoom(op.roomId);
  return getOperation(app, op.id);
}

export const MAX_AMOUNT = 2_000_000_000;

/** Исправление суммы (в копейках); null — сумма вне допустимого диапазона. */
export async function setAmount(app: App, op: Operation, amount: number): Promise<Operation | null> {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  await app.db.query('UPDATE operations SET amount = $1 WHERE id = $2', [amount, op.id]);
  notifyRoom(op.roomId);
  return getOperation(app, op.id);
}

/** Переносит трату в текущий период другого журнала; категория подбирается по тому же названию. */
export async function moveOperation(app: App, op: Operation, target: Room): Promise<Operation | null> {
  const period = await currentPeriod(app, target.id);
  if (!period) return null;
  const categories = await listCategories(app, target.id);
  const category = categories.find((c) => c.name === op.category?.name) ?? categories.find((c) => c.name === OTHER) ?? null;
  await app.db.query('UPDATE operations SET room_id = $1, period_id = $2, category_id = $3 WHERE id = $4', [
    target.id,
    period.id,
    category?.id ?? null,
    op.id,
  ]);
  notifyRoom(op.roomId);
  notifyRoom(target.id);
  return getOperation(app, op.id);
}

export async function deleteOperation(app: App, opId: number): Promise<void> {
  const [deleted] = await app.db.query<{ roomId: number }>('DELETE FROM operations WHERE id = $1 RETURNING room_id AS "roomId"', [opId]);
  if (deleted) notifyRoom(deleted.roomId);
}

// ---------- напоминания ----------

const REMINDER_HOUR = 21;

/** Пользователи, которым в 21:00 по времени комнаты пора напомнить: сегодня ни одной траты. */
export async function dueReminders(app: App, now = new Date()): Promise<User[]> {
  const users = await app.db.query<User & { tzOffsetMin: number }>(
    `SELECT u.id, u.tg_id AS "tgId", u.name, u.active_room_id AS "activeRoomId", u.reminders, r.tz_offset_min AS "tzOffsetMin"
     FROM users u JOIN rooms r ON r.id = u.active_room_id
     WHERE u.reminders AND NOT u.blocked
       AND EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => r.tz_offset_min)) = ${REMINDER_HOUR}
       AND u.last_reminded_on IS DISTINCT FROM (($1::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => r.tz_offset_min))::date
       AND EXISTS (SELECT 1 FROM periods p WHERE p.room_id = r.id AND p.closed_at IS NULL)
       -- напоминаем только тем, кто уже пользуется трекером, и только если сегодня пусто
       AND EXISTS (SELECT 1 FROM operations o WHERE o.user_id = u.id)
       AND NOT EXISTS (
         SELECT 1 FROM operations o WHERE o.user_id = u.id
           AND ((o.created_at AT TIME ZONE 'UTC') + make_interval(mins => r.tz_offset_min))::date
             = (($1::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => r.tz_offset_min))::date)`,
    [now.toISOString()],
  );
  for (const u of users) {
    await app.db.query(
      `UPDATE users SET last_reminded_on = (($1::timestamptz AT TIME ZONE 'UTC') + make_interval(mins => $2::int))::date WHERE id = $3`,
      [now.toISOString(), u.tzOffsetMin, u.id],
    );
  }
  return users;
}
