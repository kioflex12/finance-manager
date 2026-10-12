import { useEffect, useState, type ReactNode } from 'react';
import { money, tg, type Category, type Operation, type Room, type RoomColor, type Stats } from './api';

/** Цвета комнаты: пара для градиента (светлее → темнее). */
export const ROOM_COLORS: Record<RoomColor, [string, string]> = {
  violet: ['#7a28ff', '#4b2bd6'],
  blue: ['#2f6df6', '#1d4ed8'],
  teal: ['#0e9aa7', '#0b6f76'],
  green: ['#1f9d55', '#15803d'],
  orange: ['#f0731a', '#c2410c'],
  pink: ['#e0457b', '#a61e4d'],
  red: ['#e5484d', '#b91c1c'],
  graphite: ['#52525b', '#18181b'],
};

export function roomVars(color: RoomColor): React.CSSProperties {
  const [from, to] = ROOM_COLORS[color] ?? ROOM_COLORS.violet;
  return { '--room-1': from, '--room-2': to } as React.CSSProperties;
}

/** Аватар комнаты: выбранный эмодзи или первая буква названия на цвете комнаты. */
export function RoomAvatar({ room, size = 'small' }: { room: Pick<Room, 'name' | 'emoji' | 'color'>; size?: 'pill' | 'small' | 'large' }) {
  return (
    <span className={`avatar ${size}${room.emoji ? ' emoji' : ''}`} style={roomVars(room.color)}>
      {room.emoji ?? room.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

const SERIES_SLOTS = 8;

/**
 * Цвет закреплён за категорией (по её месту в списке комнаты), а не за местом в рейтинге:
 * при изменении сумм категории не перекрашиваются. Девятая и далее — нейтральные.
 */
export function categoryColor(category: Category | null, categories: Category[]): string {
  const index = category ? categories.findIndex((c) => c.id === category.id) : -1;
  return index >= 0 && index < SERIES_SLOTS ? `var(--series-${index + 1})` : 'var(--series-other)';
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  users: 'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1.5a4 4 0 0 0-3-3.87M15.5 3.63a3.5 3.5 0 0 1 0 6.74',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M6 9l6 6 6-6',
  right: 'M9 5l7 7-7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z',
} as const;

export function Icon({ name, size = 22 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Значок категории: эмодзи на подложке цвета категории. */
export function CategoryBadge({ category, color }: { category: Category | null; color: string }) {
  return (
    <span className="badge" style={{ '--badge': color } as React.CSSProperties}>
      {category?.emoji ?? '⏳'}
    </span>
  );
}

/** Доля категорий в общей сумме: одна горизонтальная полоса, нажатие на сегмент показывает его подпись. */
export function Breakdown({ stats, categories }: { stats: Stats; categories: Category[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const rows = stats.byCategory.filter((row) => row.total > 0);
  const active = rows.find((row) => (row.category?.id ?? 0) === picked);

  return (
    <div className="breakdown">
      <div className="stack" role="img" aria-label="Доли категорий в расходах">
        {rows.map((row) => {
          const id = row.category?.id ?? 0;
          return (
            <button
              key={id}
              className={picked !== null && picked !== id ? 'dim' : ''}
              style={{ flexGrow: row.total, background: categoryColor(row.category, categories) }}
              aria-label={`${row.category?.name ?? 'Без категории'}: ${money(row.total)}`}
              onClick={() => {
                tg?.HapticFeedback?.selectionChanged();
                setPicked(picked === id ? null : id);
              }}
            />
          );
        })}
      </div>
      <div className="stack-caption">
        {active
          ? `${active.category?.emoji ?? ''} ${active.category?.name ?? 'Без категории'} · ${money(active.total)} · ${share(active.total, stats.total)}`
          : 'Нажмите на сегмент, чтобы увидеть категорию'}
      </div>
    </div>
  );
}

export function share(part: number, total: number): string {
  if (!total) return '0%';
  const pct = (part / total) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** Шкала бюджета: заполнение — потрачено, при перерасходе меняет цвет и получает подпись со значком. */
export function Meter({ spent, limit }: { spent: number; limit: number }) {
  const over = spent > limit;
  return (
    <div className={over ? 'meter over' : 'meter'} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={spent}>
      <div style={{ width: `${Math.min(100, (spent / limit) * 100)}%` }} />
    </div>
  );
}

export function OperationRow(props: { op: Operation; color: string; showUser: boolean; onClick: () => void }) {
  const { op } = props;
  const time = new Date(op.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return (
    <li onClick={props.onClick}>
      <CategoryBadge category={op.category} color={props.color} />
      <span className="grow">
        <span className="title">{op.description}</span>
        <small>
          {op.category?.name ?? 'подбираю категорию'} · {time}
          {props.showUser && ` · ${op.userName}`}
        </small>
      </span>
      <b>{money(op.amount)}</b>
    </li>
  );
}

/** Системная кнопка «назад» Telegram на время, пока открыт вложенный экран или шторка. */
export function useBack(onBack: () => void): void {
  useEffect(() => {
    tg?.BackButton?.show();
    tg?.BackButton?.onClick(onBack);
    return () => {
      tg?.BackButton?.offClick(onBack);
      tg?.BackButton?.hide();
    };
  }, [onBack]);
}

/** Нижняя шторка. Закрывается тапом по фону и кнопкой «назад». */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useBack(onClose);
  return (
    <div className="sheet" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <div className="grabber" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
