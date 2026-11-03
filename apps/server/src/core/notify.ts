import * as s from './service.js';
import { operationLine, totalsLine } from './text.js';

/**
 * Личное сообщение о новых тратах остальным участникам общего журнала — чтобы видеть,
 * что записано, не открывая приложение. В групповых чатах не рассылаем: там запись и так видна.
 */
export async function notifyExpenseAdded(app: s.App, room: s.Room, author: s.User, ops: s.Operation[]): Promise<void> {
  if (!app.send || ops.length === 0 || room.tgChatId) return;
  const others = (await s.listMembers(app, room.id)).filter((m) => m.id !== author.id && !m.blocked);
  if (others.length === 0) return;
  const lines = [`👛 ${author.name} записал в «${room.name}»:`, ...ops.map((op) => operationLine(op))];
  const period = await s.currentPeriod(app, room.id);
  if (period) {
    const stats = await s.periodStats(app, period.id);
    lines.push(totalsLine(stats, s.budgetInfo(room, period, stats.total)));
  }
  const text = lines.join('\n');
  for (const member of others) {
    // участник мог не запустить бота в личке или заблокировать его — остальным всё равно отправляем
    await app.send(member.tgId, text).catch((err) => console.error('expense notify failed', member.tgId, err));
  }
}
