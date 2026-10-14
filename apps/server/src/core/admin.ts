import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { notifyRoom } from './events.js';
import { metrics } from './metrics.js';
import { deleteRoom, type App } from './service.js';

/**
 * Запросы админки. Всё считается по требованию, когда админка открыта:
 * фоновой работы и лишней нагрузки на сервер нет.
 */

export async function adminStats(app: App) {
  const [users] = await app.db.query<Record<string, number>>(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS "new1",
       COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "new7",
       COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS "new30",
       COUNT(*) FILTER (WHERE last_seen_at > now() - interval '1 day')::int AS "seen1",
       COUNT(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS "seen7",
       COUNT(*) FILTER (WHERE blocked)::int AS blocked
     FROM users`,
  );
  // активные — те, кто записал хотя бы одну трату за период
  const [active] = await app.db.query<Record<string, number>>(
    `SELECT COUNT(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '1 day')::int AS "d1",
       COUNT(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days')::int AS "d7",
       COUNT(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '30 days')::int AS "d30"
     FROM operations`,
  );
  const [journals] = await app.db.query<Record<string, number>>(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE tg_chat_id IS NOT NULL)::int AS "groups",
       COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM room_members m WHERE m.room_id = rooms.id) > 1)::int AS shared
     FROM rooms`,
  );
  const [operations] = await app.db.query<Record<string, number>>(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(amount), 0)::float8 AS sum,
       COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS "count1",
       COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '1 day'), 0)::float8 AS "sum1",
       COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "count7",
       COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '7 days'), 0)::float8 AS "sum7",
       COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS "count30",
       COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '30 days'), 0)::float8 AS "sum30"
     FROM operations`,
  );
  // по дням за 30 дней (по Москве): новые пользователи, траты и сколько людей их записали
  const daily = await app.db.query<{ day: string; users: number; operations: number; active: number }>(
    `WITH days AS (
       SELECT generate_series((now() AT TIME ZONE 'Europe/Moscow')::date - 29, (now() AT TIME ZONE 'Europe/Moscow')::date, interval '1 day')::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       (SELECT COUNT(*) FROM users u WHERE (u.created_at AT TIME ZONE 'Europe/Moscow')::date = d.day)::int AS users,
       (SELECT COUNT(*) FROM operations o WHERE (o.created_at AT TIME ZONE 'Europe/Moscow')::date = d.day)::int AS operations,
       (SELECT COUNT(DISTINCT o.user_id) FROM operations o WHERE (o.created_at AT TIME ZONE 'Europe/Moscow')::date = d.day)::int AS active
     FROM days d ORDER BY d.day`,
  );
  const topItems = await app.db.query<{ item: string; count: number; sum: number }>(
    `SELECT item, COUNT(*)::int AS count, SUM(amount)::float8 AS sum FROM operations
     WHERE created_at > now() - interval '30 days' GROUP BY item ORDER BY count DESC, sum DESC LIMIT 10`,
  );
  const topCategories = await app.db.query<{ name: string; emoji: string; count: number; sum: number }>(
    `SELECT c.name, MIN(c.emoji) AS emoji, COUNT(*)::int AS count, SUM(o.amount)::float8 AS sum
     FROM operations o JOIN categories c ON c.id = o.category_id
     WHERE o.created_at > now() - interval '30 days' GROUP BY c.name ORDER BY sum DESC LIMIT 10`,
  );

  return { users: { ...users, active }, journals, operations, daily, topItems, topCategories, server: await serverHealth(app) };
}

async function serverHealth(app: App) {
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  let dbSizeMb: number | null = null;
  try {
    const [row] = await app.db.query<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
    dbSizeMb = row ? mb(row.size) : null;
  } catch {
    // встроенная база при локальном запуске может не уметь считать размер
  }
  let disk: { freeMb: number; totalMb: number } | null = null;
  try {
    const fs = await statfs('/');
    disk = { freeMb: mb(fs.bavail * fs.bsize), totalMb: mb(fs.blocks * fs.bsize) };
  } catch {
    disk = null;
  }
  const service = (m: typeof metrics.llm) => ({
    calls: m.calls,
    failures: m.failures,
    avgMs: m.calls ? Math.round(m.totalMs / m.calls) : 0,
  });
  return {
    uptimeSec: Math.round(process.uptime()),
    startedAt: metrics.startedAt,
    appMemoryMb: mb(memory.rss),
    freeMemoryMb: mb(os.freemem()),
    totalMemoryMb: mb(os.totalmem()),
    load: os.loadavg()[0] ?? 0,
    dbSizeMb,
    disk,
    llm: service(metrics.llm),
    stt: service(metrics.stt),
  };
}

export interface AdminUserRow {
  id: number;
  tgId: string;
  name: string;
  blocked: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  journals: number;
  operations: number;
  sum: number;
  lastOperationAt: Date | null;
}

const USER_STATS = `u.id, u.tg_id AS "tgId", u.name, u.blocked, u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
  (SELECT COUNT(*) FROM room_members m WHERE m.user_id = u.id)::int AS journals,
  (SELECT COUNT(*) FROM operations o WHERE o.user_id = u.id)::int AS operations,
  (SELECT COALESCE(SUM(amount), 0) FROM operations o WHERE o.user_id = u.id)::float8 AS sum,
  (SELECT MAX(created_at) FROM operations o WHERE o.user_id = u.id) AS "lastOperationAt"`;

export async function adminUsers(app: App, query: string): Promise<AdminUserRow[]> {
  const q = query.trim();
  return app.db.query<AdminUserRow>(
    `SELECT ${USER_STATS} FROM users u
     WHERE $1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.tg_id = $1
     ORDER BY u.last_seen_at DESC LIMIT 200`,
    [q],
  );
}

export async function adminUser(app: App, userId: number) {
  const [user] = await app.db.query<AdminUserRow>(`SELECT ${USER_STATS} FROM users u WHERE u.id = $1`, [userId]);
  if (!user) return null;
  const journals = await app.db.query<{ id: number; name: string; emoji: string | null; owner: boolean; members: number }>(
    `SELECT r.id, r.name, r.emoji, r.owner_id = $1 AS owner,
       (SELECT COUNT(*) FROM room_members m2 WHERE m2.room_id = r.id)::int AS members
     FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = $1 ORDER BY r.id`,
    [userId],
  );
  const recent = await app.db.query<{ id: number; item: string; amount: number; createdAt: Date; journal: string }>(
    `SELECT o.id, o.item, o.amount, o.created_at AS "createdAt", r.name AS journal
     FROM operations o JOIN rooms r ON r.id = o.room_id WHERE o.user_id = $1 ORDER BY o.id DESC LIMIT 20`,
    [userId],
  );
  return { user, journals, recent };
}

export async function setBlocked(app: App, userId: number, blocked: boolean): Promise<void> {
  await app.db.query('UPDATE users SET blocked = $1 WHERE id = $2', [blocked, userId]);
}

/**
 * Удаляет пользователя и его данные: журналы, где он единственный участник или владелец,
 * его траты в общих журналах, участие и сам аккаунт.
 */
export async function deleteUser(app: App, userId: number): Promise<void> {
  const owned = await app.db.query<{ id: number }>('SELECT id FROM rooms WHERE owner_id = $1', [userId]);
  for (const room of owned) await deleteRoom(app, room.id);
  const touched = await app.db.query<{ roomId: number }>(
    'DELETE FROM operations WHERE user_id = $1 RETURNING room_id AS "roomId"',
    [userId],
  );
  await app.db.query('DELETE FROM room_members WHERE user_id = $1', [userId]);
  await app.db.query('DELETE FROM users WHERE id = $1', [userId]);
  for (const roomId of new Set(touched.map((t) => t.roomId))) notifyRoom(roomId);
}

export async function adminJournals(app: App) {
  return app.db.query<{
    id: number;
    name: string;
    emoji: string | null;
    color: string;
    group: boolean;
    owner: string;
    members: number;
    operations: number;
    periodSum: number;
    lastOperationAt: Date | null;
  }>(
    `SELECT r.id, r.name, r.emoji, r.color, r.tg_chat_id IS NOT NULL AS "group", u.name AS owner,
       (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id)::int AS members,
       (SELECT COUNT(*) FROM operations o WHERE o.room_id = r.id)::int AS operations,
       (SELECT COALESCE(SUM(o.amount), 0) FROM operations o JOIN periods p ON p.id = o.period_id
          WHERE o.room_id = r.id AND p.closed_at IS NULL)::float8 AS "periodSum",
       (SELECT MAX(o.created_at) FROM operations o WHERE o.room_id = r.id) AS "lastOperationAt"
     FROM rooms r JOIN users u ON u.id = r.owner_id
     ORDER BY "lastOperationAt" DESC NULLS LAST, r.id DESC LIMIT 200`,
  );
}

export async function adminUserTgIds(app: App): Promise<string[]> {
  return (await app.db.query<{ tgId: string }>('SELECT tg_id AS "tgId" FROM users WHERE NOT blocked ORDER BY id')).map((u) => u.tgId);
}
