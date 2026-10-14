declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe: { start_param?: string };
        colorScheme?: 'light' | 'dark';
        ready(): void;
        expand(): void;
        openTelegramLink(url: string): void;
        showConfirm?(message: string, callback: (ok: boolean) => void): void;
        setHeaderColor?(color: string): void;
        setBackgroundColor?(color: string): void;
        disableVerticalSwipes?(): void;
        onEvent?(event: 'themeChanged', handler: () => void): void;
        BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
        HapticFeedback?: {
          notificationOccurred(type: 'success' | 'error'): void;
          selectionChanged(): void;
        };
      };
    };
  }
}

export const tg = window.Telegram?.WebApp;

export type RoomColor = 'violet' | 'blue' | 'teal' | 'green' | 'orange' | 'pink' | 'red' | 'graphite';

export interface Room {
  id: number;
  name: string;
  ownerId: number;
  emoji: string | null;
  color: RoomColor;
  periodKind: 'month' | 'days';
  periodDays: number;
  autoRenew: boolean;
  budget: number | null;
  inviteCode: string;
}

export interface Category {
  id: number;
  name: string;
  emoji: string;
}

export interface Operation {
  id: number;
  userName: string;
  amount: number;
  description: string;
  /** позиция: общее название одинаковых трат («кофе» для «кофеёчек») */
  item: string;
  category: Category | null;
  createdAt: string;
}

export interface Period {
  id: number;
  label: string;
  startsAt: string;
  endsAt: string;
  closedAt: string | null;
  total?: number;
}

export interface Stats {
  total: number;
  count: number;
  byCategory: { category: Category | null; total: number; count: number }[];
  byMember: { userId: number; name: string; total: number }[];
}

export interface Budget {
  budget: number;
  left: number;
  daysLeft: number;
  perDay: number;
}

export interface Overview {
  room: Room;
  period: Period | null;
  stats: Stats | null;
  budget: Budget | null;
}

export interface RoomView extends Overview {
  categories: Category[];
  members: { id: number; name: string }[];
}

export interface RoomPatch {
  name?: string;
  budget?: number | null;
  autoRenew?: boolean;
  periodKind?: 'month' | 'days';
  periodDays?: number;
  emoji?: string | null;
  color?: RoomColor;
  active?: boolean;
}

export interface Me {
  user: { id: number; name: string };
  activeRoomId: number;
  rooms: Room[];
  botUsername: string;
}

export interface NewRoom {
  name: string;
  periodKind: 'month' | 'days';
  periodDays: number;
  autoRenew: boolean;
  budget: number | null;
}

export class ApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const initData = tg?.initData;
  const res = await fetch(`/api${url}`, {
    method,
    headers: {
      ...(initData ? { authorization: `tma ${initData}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? String(res.status));
  return data as T;
}

/** Адрес потока событий журнала; подпись Telegram идёт параметром, заголовки EventSource не поддерживает. */
export function roomEventsUrl(roomId: number): string {
  const initData = tg?.initData;
  return `/api/rooms/${roomId}/events${initData ? `?auth=${encodeURIComponent(initData)}` : ''}`;
}

export const api = {
  me: () => call<Me>('GET', '/me'),
  join: (code: string) => call<{ room: Room }>('POST', '/join', { code }),
  room: (id: number, periodId?: number) => call<RoomView>('GET', `/rooms/${id}${periodId ? `?periodId=${periodId}` : ''}`),
  createRoom: (room: NewRoom) => call<{ room: Room }>('POST', '/rooms', room),
  updateRoom: (id: number, patch: RoomPatch) => call<{ room: Room }>('PATCH', `/rooms/${id}`, patch),
  /** владелец удаляет комнату, участник выходит из неё */
  deleteRoom: (id: number) => call<{ activeRoomId: number; rooms: Room[] }>('DELETE', `/rooms/${id}`),
  clearOperations: (id: number) => call<unknown>('DELETE', `/rooms/${id}/operations`),
  periods: (id: number) => call<{ periods: Period[] }>('GET', `/rooms/${id}/periods`),
  startPeriod: (id: number) => call<unknown>('POST', `/rooms/${id}/periods`),
  /** categoryId: undefined — все траты периода, null — без категории */
  operations: (id: number, periodId: number, categoryId?: number | null) =>
    call<{ operations: Operation[] }>(
      'GET',
      `/rooms/${id}/operations?periodId=${periodId}${categoryId === undefined ? '' : `&categoryId=${categoryId ?? 'none'}`}`,
    ),
  add: (id: number, text: string) => call<Overview & { operations: Operation[] }>('POST', `/rooms/${id}/operations`, { text }),
  setCategory: (opId: number, categoryId: number) => call<{ operation: Operation }>('PATCH', `/operations/${opId}`, { categoryId }),
  remove: (opId: number) => call<unknown>('DELETE', `/operations/${opId}`),
};

export function money(kopecks: number): string {
  const rub = Math.trunc(kopecks / 100);
  const kop = Math.abs(Math.round(kopecks % 100));
  return `${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${kop ? ',' + String(kop).padStart(2, '0') : ''} ₽`;
}

/** Подтверждение необратимого действия: системный диалог Telegram, вне его — браузерный. */
export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(message, resolve);
    else resolve(window.confirm(message));
  });
}

const DAY_MS = 86_400_000;

/** «Сегодня», «Вчера» или «10 октября» — заголовок дня в ленте трат. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(date)) / DAY_MS);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
