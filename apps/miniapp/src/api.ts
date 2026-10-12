declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe: { start_param?: string };
        ready(): void;
        expand(): void;
        openTelegramLink(url: string): void;
        HapticFeedback?: { notificationOccurred(type: 'success' | 'error'): void };
      };
    };
  }
}

export interface Room {
  id: number;
  name: string;
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
  category: Category | null;
  createdAt: string;
}

export interface Period {
  id: number;
  label: string;
  closedAt: string | null;
  total?: number;
}

export interface Overview {
  room: Room;
  period: Period | null;
  stats: {
    total: number;
    count: number;
    byCategory: { category: Category | null; total: number; count: number }[];
    byMember: { userId: number; name: string; total: number }[];
  } | null;
  budget: { budget: number; left: number; daysLeft: number; perDay: number } | null;
}

export interface RoomView extends Overview {
  categories: Category[];
  members: { id: number; name: string }[];
}

export interface Me {
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
  const initData = window.Telegram?.WebApp.initData;
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

export const api = {
  me: () => call<Me>('GET', '/me'),
  join: (code: string) => call<{ room: Room }>('POST', '/join', { code }),
  room: (id: number, periodId?: number) => call<RoomView>('GET', `/rooms/${id}${periodId ? `?periodId=${periodId}` : ''}`),
  createRoom: (room: NewRoom) => call<{ room: Room }>('POST', '/rooms', room),
  updateRoom: (id: number, patch: { budget?: number | null; autoRenew?: boolean; active?: boolean }) =>
    call<{ room: Room }>('PATCH', `/rooms/${id}`, patch),
  periods: (id: number) => call<{ periods: Period[] }>('GET', `/rooms/${id}/periods`),
  startPeriod: (id: number) => call<unknown>('POST', `/rooms/${id}/periods`),
  operations: (id: number, periodId: number, categoryId: number | null) =>
    call<{ operations: Operation[] }>('GET', `/rooms/${id}/operations?periodId=${periodId}&categoryId=${categoryId ?? 'none'}`),
  add: (id: number, text: string) => call<Overview & { operations: Operation[] }>('POST', `/rooms/${id}/operations`, { text }),
  setCategory: (opId: number, categoryId: number) => call<{ operation: Operation }>('PATCH', `/operations/${opId}`, { categoryId }),
  remove: (opId: number) => call<unknown>('DELETE', `/operations/${opId}`),
};

export function money(kopecks: number): string {
  const rub = Math.trunc(kopecks / 100);
  const kop = Math.abs(Math.round(kopecks % 100));
  return `${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${kop ? ',' + String(kop).padStart(2, '0') : ''} ₽`;
}
