export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

/** Сессия — httpOnly cookie, её ставит сервер; запросы с изменениями идут только JSON. */
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${url}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') window.dispatchEvent(new Event('admin:logout'));
  if (!res.ok) throw new ApiError(data.error ?? String(res.status), res.status);
  return data as T;
}

export interface DailyPoint {
  day: string;
  users: number;
  operations: number;
  active: number;
}

interface ServiceCalls {
  calls: number;
  failures: number;
  avgMs: number;
}

export interface Stats {
  users: { total: number; new1: number; new7: number; new30: number; seen1: number; seen7: number; blocked: number; active: { d1: number; d7: number; d30: number } };
  journals: { total: number; groups: number; shared: number };
  operations: { total: number; sum: number; count1: number; sum1: number; count7: number; sum7: number; count30: number; sum30: number };
  daily: DailyPoint[];
  topItems: { item: string; count: number; sum: number }[];
  topCategories: { name: string; emoji: string; count: number; sum: number }[];
  server: {
    uptimeSec: number;
    appMemoryMb: number;
    freeMemoryMb: number;
    totalMemoryMb: number;
    load: number;
    dbSizeMb: number | null;
    disk: { freeMb: number; totalMb: number } | null;
    llm: ServiceCalls;
    stt: ServiceCalls;
  };
}

export interface User {
  id: number;
  tgId: string;
  name: string;
  blocked: boolean;
  createdAt: string;
  lastSeenAt: string;
  journals: number;
  operations: number;
  sum: number;
  lastOperationAt: string | null;
}

export interface UserDetails {
  user: User;
  journals: { id: number; name: string; emoji: string | null; owner: boolean; members: number }[];
  recent: { id: number; item: string; amount: number; createdAt: string; journal: string }[];
}

export interface Journal {
  id: number;
  name: string;
  emoji: string | null;
  color: string;
  group: boolean;
  owner: string;
  members: number;
  operations: number;
  periodSum: number;
  lastOperationAt: string | null;
}

export interface JournalDetails {
  room: { id: number; name: string; emoji: string | null; periodKind: 'month' | 'days'; periodDays: number; budget: number | null; createdAt?: string };
  stats: { total: number; count: number; byCategory: { category: { name: string; emoji: string } | null; total: number; count: number }[] } | null;
  members: { id: number; name: string }[];
  periods: { id: number; total: number; startsAt: string; endsAt: string; closedAt: string | null }[];
}

export interface AuditEntry {
  id: number;
  action: string;
  details: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export const api = {
  login: (login: string, password: string) => call<{ login: string }>('POST', '/login', { login, password }),
  logout: () => call<unknown>('POST', '/logout'),
  me: () => call<{ login: string }>('GET', '/me'),
  audit: () => call<{ entries: AuditEntry[] }>('GET', '/audit'),
  stats: () => call<Stats>('GET', '/stats'),
  users: (q: string) => call<{ users: User[] }>('GET', `/users?q=${encodeURIComponent(q)}`),
  user: (id: number) => call<UserDetails>('GET', `/users/${id}`),
  block: (id: number, blocked: boolean) => call<unknown>('POST', `/users/${id}/block`, { blocked }),
  message: (id: number, text: string) => call<unknown>('POST', `/users/${id}/message`, { text }),
  deleteUser: (id: number) => call<unknown>('DELETE', `/users/${id}`),
  journals: () => call<{ journals: Journal[] }>('GET', '/journals'),
  journal: (id: number) => call<JournalDetails>('GET', `/journals/${id}`),
  deleteJournal: (id: number) => call<unknown>('DELETE', `/journals/${id}`),
  broadcast: (text: string) => call<{ recipients: number }>('POST', '/broadcast', { text }),
};

const ERRORS: Record<string, string> = {
  wrong_credentials: 'Неверный логин или пароль',
  too_many_attempts: 'Слишком много попыток. Подождите 15 минут',
  bot_offline: 'Бот сейчас не запущен',
  not_delivered: 'Не доставлено: пользователь, скорее всего, остановил бота',
  empty: 'Пустое сообщение',
  not_found: 'Не найдено — возможно, уже удалено',
};

export function errorText(err: unknown): string {
  return (err instanceof ApiError && ERRORS[err.code]) || 'Что-то пошло не так. Попробуйте ещё раз';
}

export function money(kopecks: number): string {
  const rub = Math.trunc(kopecks / 100);
  const kop = Math.abs(Math.round(kopecks % 100));
  return `${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${kop ? ',' + String(kop).padStart(2, '0') : ''} ₽`;
}

export const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function since(iso: string | null): string {
  if (!iso) return '—';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return date(iso);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
