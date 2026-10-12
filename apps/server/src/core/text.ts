import { formatMoney } from './parse.js';
import type { BudgetInfo, ClosedPeriod, Operation, Period, Room, Stats } from './service.js';

const DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function localDate(date: Date, room: Room): string {
  return DATE.format(new Date(date.getTime() + room.tzOffsetMin * 60_000));
}

export function periodLabel(room: Room, period: Period): string {
  // конец периода — исключающая граница, показываем последний день
  return `${localDate(period.startsAt, room)} — ${localDate(new Date(period.endsAt.getTime() - 1), room)}`;
}

export function operationLine(op: Operation): string {
  const category = op.category ? `${op.category.emoji} ${op.category.name}` : '⏳ подбираю категорию';
  return `✅ ${formatMoney(op.amount)} · ${op.description} — ${category}`;
}

export function budgetLine(info: BudgetInfo): string {
  return info.left >= 0
    ? `Осталось ${formatMoney(info.left)} из ${formatMoney(info.budget)} · ≈${formatMoney(info.perDay)} в день`
    : `Бюджет ${formatMoney(info.budget)} превышен на ${formatMoney(-info.left)}`;
}

export function totalsLine(stats: Stats, budget: BudgetInfo | null): string {
  return `За период: ${formatMoney(stats.total)}${budget ? '\n' + budgetLine(budget) : ''}`;
}

function categoryLines(stats: Stats, previous: Stats | null): string[] {
  return stats.byCategory.map(({ category, total }) => {
    const before = previous?.byCategory.find((c) => c.category?.name === category?.name)?.total;
    return `${category?.emoji ?? '📦'} ${category?.name ?? 'Без категории'} — ${formatMoney(total)}${delta(total, before)}`;
  });
}

function delta(now: number, before: number | undefined): string {
  if (!before) return '';
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`;
}

/** Текущее состояние периода по запросу — /summary в чате. */
export function reportText(room: Room, period: Period, stats: Stats, budget: BudgetInfo | null): string {
  const lines = [`📊 ${room.name} · ${periodLabel(room, period)}`, '', `Потрачено: ${formatMoney(stats.total)}`];
  if (budget) lines.push(budgetLine(budget));
  if (stats.count) lines.push('', ...categoryLines(stats, null));
  if (stats.byMember.length > 1) lines.push('', ...stats.byMember.map((m) => `👤 ${m.name} — ${formatMoney(m.total)}`));
  return lines.join('\n');
}

/** Итоговая сводка закрытого периода со сравнением с предыдущим. */
export function summaryText({ room, period, stats, previous, renewed }: ClosedPeriod): string {
  const lines = [
    `🏁 Итоги: ${room.name} · ${periodLabel(room, period)}`,
    '',
    `Потрачено: ${formatMoney(stats.total)}${delta(stats.total, previous?.total)}`,
  ];
  if (previous?.total) lines.push(`В прошлом периоде: ${formatMoney(previous.total)}`);
  if (room.budget) {
    const left = room.budget - stats.total;
    lines.push(
      left >= 0
        ? `Бюджет ${formatMoney(room.budget)} — уложились, осталось ${formatMoney(left)} 👍`
        : `Бюджет ${formatMoney(room.budget)} — перерасход ${formatMoney(-left)}`,
    );
  }
  lines.push('', ...categoryLines(stats, previous));
  if (stats.byMember.length > 1) lines.push('', ...stats.byMember.map((m) => `👤 ${m.name} — ${formatMoney(m.total)}`));
  lines.push('', renewed ? 'Новый период уже идёт — продолжайте записывать траты.' : 'Срок комнаты закончился.');
  return lines.join('\n');
}
