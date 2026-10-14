import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { App } from './service.js';

/**
 * Учётные записи сайта-админки. Пароли — scrypt с солью, сессии — случайный токен в cookie,
 * в базе только его sha256. Регистрация — по приглашению; первого администратора пускает
 * код установки из окружения (ADMIN_SETUP_CODE), пока в базе нет ни одного админа.
 */

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_DAYS = 14;
export const INVITE_DAYS = 3;
export const MIN_PASSWORD = 8;
const KEY_LENGTH = 32;

export interface Admin {
  id: number;
  login: string;
  name: string;
  createdAt: Date;
  lastLoginAt: Date | null;
}

const ADMIN = `id, login, name, created_at AS "createdAt", last_login_at AS "lastLoginAt"`;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const normalizeLogin = (login: string) => login.trim().toLowerCase();

export async function adminCount(app: App): Promise<number> {
  const [row] = await app.db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM admins');
  return row?.count ?? 0;
}

export async function listAdmins(app: App): Promise<Admin[]> {
  return app.db.query<Admin>(`SELECT ${ADMIN} FROM admins ORDER BY id`);
}

export type RegisterError = 'invite_required' | 'invite_invalid' | 'login_taken' | 'weak_password' | 'bad_login';

/** Регистрация по приглашению; первый админ — по коду установки. */
export async function registerAdmin(
  app: App,
  input: { login: string; name: string; password: string; invite: string },
  setupCode: string,
): Promise<Admin | RegisterError> {
  const login = normalizeLogin(input.login);
  if (!/^[\p{L}\p{N}._@+-]{3,64}$/u.test(login)) return 'bad_login';
  if (input.password.length < MIN_PASSWORD) return 'weak_password';
  if (!input.invite) return 'invite_required';

  const first = (await adminCount(app)) === 0;
  let inviteHash: string | null = null;
  if (first) {
    if (!setupCode || input.invite !== setupCode) return 'invite_invalid';
  } else {
    inviteHash = sha256(input.invite);
    const [invite] = await app.db.query(
      'SELECT 1 FROM admin_invites WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [inviteHash],
    );
    if (!invite) return 'invite_invalid';
  }

  const [taken] = await app.db.query('SELECT 1 FROM admins WHERE login = $1', [login]);
  if (taken) return 'login_taken';
  const [admin] = await app.db.query<Admin>(
    `INSERT INTO admins (login, name, password_hash) VALUES ($1, $2, $3) RETURNING ${ADMIN}`,
    [login, input.name.trim().slice(0, 64) || login, await hashPassword(input.password)],
  );
  if (inviteHash) {
    await app.db.query('UPDATE admin_invites SET used_at = now(), used_by = $2 WHERE code_hash = $1', [inviteHash, admin!.id]);
  }
  return admin!;
}

export async function checkCredentials(app: App, login: string, password: string): Promise<Admin | null> {
  const [row] = await app.db.query<Admin & { passwordHash: string }>(
    `SELECT ${ADMIN}, password_hash AS "passwordHash" FROM admins WHERE login = $1`,
    [normalizeLogin(login)],
  );
  // хэшируем и для несуществующего логина — чтобы по времени ответа нельзя было подобрать логины
  const ok = await verifyPassword(password, row?.passwordHash ?? (await DUMMY_HASH));
  if (!row || !ok) return null;
  const { passwordHash: _, ...admin } = row;
  return admin;
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export async function changePassword(app: App, adminId: number, current: string, next: string): Promise<'ok' | 'wrong_password' | 'weak_password'> {
  if (next.length < MIN_PASSWORD) return 'weak_password';
  const [row] = await app.db.query<{ login: string }>('SELECT login FROM admins WHERE id = $1', [adminId]);
  if (!row || !(await checkCredentials(app, row.login, current))) return 'wrong_password';
  await app.db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [await hashPassword(next), adminId]);
  return 'ok';
}

export async function createSession(app: App, adminId: number, meta: { ip: string; userAgent: string }): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [sha256(token), adminId, SESSION_DAYS, meta.ip, meta.userAgent.slice(0, 300)],
  );
  await app.db.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [adminId]);
  await app.db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  return token;
}

export async function sessionAdmin(app: App, token: string | undefined): Promise<Admin | null> {
  if (!token) return null;
  const [admin] = await app.db.query<Admin>(
    `SELECT a.id, a.login, a.name, a.created_at AS "createdAt", a.last_login_at AS "lastLoginAt"
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return admin ?? null;
}

export async function endSession(app: App, token: string | undefined): Promise<void> {
  if (token) await app.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Выход со всех устройств, кроме текущего — после смены пароля. */
export async function endOtherSessions(app: App, adminId: number, keepToken: string | undefined): Promise<void> {
  await app.db.query('DELETE FROM admin_sessions WHERE admin_id = $1 AND token_hash <> $2', [adminId, sha256(keepToken ?? '')]);
}

/** Приглашение: код показывается один раз, в базе — только хэш. */
export async function createInvite(app: App, adminId: number): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(18).toString('base64url');
  const [row] = await app.db.query<{ expiresAt: Date }>(
    `INSERT INTO admin_invites (code_hash, created_by, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))
     RETURNING expires_at AS "expiresAt"`,
    [sha256(code), adminId, INVITE_DAYS],
  );
  return { code, expiresAt: row!.expiresAt };
}

export async function removeAdmin(app: App, adminId: number): Promise<void> {
  await app.db.query('DELETE FROM admins WHERE id = $1', [adminId]);
}

export async function audit(app: App, adminId: number | null, action: string, details: object, ip: string): Promise<void> {
  await app.db.query('INSERT INTO admin_audit (admin_id, action, details, ip) VALUES ($1, $2, $3, $4)', [
    adminId,
    action,
    JSON.stringify(details),
    ip,
  ]);
}

export async function auditLog(app: App, limit = 200) {
  return app.db.query<{ id: number; admin: string | null; action: string; details: Record<string, unknown>; ip: string | null; createdAt: Date }>(
    `SELECT l.id, a.name AS admin, l.action, l.details, l.ip, l.created_at AS "createdAt"
     FROM admin_audit l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT $1`,
    [limit],
  );
}

/** Ограничение попыток входа: не больше 5 неудач за 15 минут на пару «адрес + логин». Хранится в памяти. */
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
