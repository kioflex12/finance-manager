import { call } from '../api';

export interface DailyPoint {
  day: string;
  users: number;
  operations: number;
  active: number;
}

export interface ServiceCalls {
  calls: number;
  failures: number;
  avgMs: number;
}

export interface AdminStats {
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

export interface AdminUser {
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

export interface AdminUserDetails {
  user: AdminUser;
  isAdmin: boolean;
  journals: { id: number; name: string; emoji: string | null; owner: boolean; members: number }[];
  recent: { id: number; item: string; amount: number; createdAt: string; journal: string }[];
}

export interface AdminJournal {
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

export interface AdminJournalDetails {
  room: { id: number; name: string; emoji: string | null; color: string; periodKind: 'month' | 'days'; periodDays: number; budget: number | null };
  stats: { total: number; count: number; byCategory: { category: { name: string; emoji: string } | null; total: number; count: number }[] } | null;
  members: { id: number; name: string }[];
  periods: { id: number; total: number; closedAt: string | null }[];
}

export const adminApi = {
  stats: () => call<AdminStats>('GET', '/admin/stats'),
  users: (q: string) => call<{ users: AdminUser[] }>('GET', `/admin/users?q=${encodeURIComponent(q)}`),
  user: (id: number) => call<AdminUserDetails>('GET', `/admin/users/${id}`),
  block: (id: number, blocked: boolean) => call<unknown>('POST', `/admin/users/${id}/block`, { blocked }),
  message: (id: number, text: string) => call<unknown>('POST', `/admin/users/${id}/message`, { text }),
  deleteUser: (id: number) => call<unknown>('DELETE', `/admin/users/${id}`),
  journals: () => call<{ journals: AdminJournal[] }>('GET', '/admin/journals'),
  journal: (id: number) => call<AdminJournalDetails>('GET', `/admin/journals/${id}`),
  deleteJournal: (id: number) => call<unknown>('DELETE', `/admin/journals/${id}`),
  broadcast: (text: string) => call<{ recipients: number }>('POST', '/admin/broadcast', { text }),
};
