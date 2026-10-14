import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { App } from './service.js';

/**
 * Вход в админку: один логин и пароль из настроек сервера (ADMIN_LOGIN, ADMIN_PASSWORD).
 * Регистрации нет. Сессия — подписанная cookie со сроком действия; ключ подписи выводится
 * из логина и пароля, поэтому смена пароля в настройках сразу завершает все сессии.
 */

export const SESSION_DAYS = 14;

export interface Credentials {
  login: string;
  password: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Сравнение за постоянное время: по скорости ответа нельзя угадать, сколько символов совпало. */
const sameText = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function checkLogin(configured: Credentials, login: string, password: string): boolean {
  if (!configured.login || !configured.password) return false;
  // обе проверки всегда выполняются — время ответа не выдаёт, верный ли логин
  const loginOk = sameText(login.trim().toLowerCase(), configured.login.trim().toLowerCase());
  const passwordOk = sameText(password, configured.password);
  return loginOk && passwordOk;
}

function signature(configured: Credentials, expires: number): string {
  const key = createHmac('sha256', 'fm-admin-session').update(`${configured.login}\n${configured.password}`).digest();
  return createHmac('sha256', key).update(String(expires)).digest('base64url');
}

export function createSession(configured: Credentials, now = Date.now()): string {
  const expires = now + SESSION_DAYS * 86_400_000;
  return `${expires}.${signature(configured, expires)}`;
}

export function validSession(configured: Credentials, token: string | undefined, now = Date.now()): boolean {
  if (!token || !configured.login || !configured.password) return false;
  const [expiresText, sig] = token.split('.');
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < now || !sig) return false;
  return sameText(sig, signature(configured, expires));
}

export async function audit(app: App, action: string, details: object, ip: string): Promise<void> {
  await app.db.query('INSERT INTO admin_audit (action, details, ip) VALUES ($1, $2, $3)', [action, JSON.stringify(details), ip]);
}

export async function auditLog(app: App, limit = 200) {
  return app.db.query<{ id: number; action: string; details: Record<string, unknown>; ip: string | null; createdAt: Date }>(
    `SELECT id, action, details, ip, created_at AS "createdAt" FROM admin_audit ORDER BY id DESC LIMIT $1`,
    [limit],
  );
}

/** Ограничение попыток входа: не больше 5 неудач за 15 минут с одного адреса. Хранится в памяти. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(key, list);
    return list;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
