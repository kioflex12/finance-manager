import { readdir, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Postgres по url; без url — встроенная PGlite (в памяти, если не задан dataDir). */
export async function openDb(url?: string, dataDir?: string): Promise<Db> {
  const db = url ? await openPg(url) : await openPglite(dataDir);
  await migrate(db);
  return db;
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  return {
    query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const lite = new PGlite(dataDir);
  return {
    query: async (sql, params) => (await lite.query(sql, params as unknown[])).rows as never,
    exec: async (sql) => void (await lite.exec(sql)),
    close: () => lite.close(),
  };
}

async function migrate(db: Db): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY)');
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM _migrations')).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
  }
}
