import { readFileSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Оповещения владельцу в Telegram о проблемах сервера: мало места на диске, не открывается база,
 * падают фоновые задачи. Одно и то же оповещение — не чаще раза в 6 часов, в том числе между
 * перезапусками (отметка хранится во временном файле), чтобы перезапуски по кругу не засыпали чат.
 */

const REPEAT_MS = 6 * 3600_000;
export const LOW_DISK_MB = 400;
const STAMP_FILE = path.join(os.tmpdir(), 'finance-manager-alerts.json');

function readStamps(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export type Alert = (key: string, text: string) => Promise<void>;

/** chatId пустой — оповещения выключены. send — отправка через бота или напрямую через Bot API. */
export function createAlerts(chatId: string, send: (chatId: string, text: string) => Promise<void>, now = () => Date.now()): Alert {
  return async (key, text) => {
    if (!chatId) return;
    const stamps = readStamps();
    const last = stamps[key];
    if (last !== undefined && now() - last < REPEAT_MS) return;
    stamps[key] = now();
    try {
      writeFileSync(STAMP_FILE, JSON.stringify(stamps));
    } catch {
      // нет записи во временную папку (например, диск полон) — всё равно пробуем оповестить
    }
    await send(chatId, `⚠️ Finance Manager: ${text}`).catch((err) => console.error('alert failed', err));
  };
}

/** Отправка без запущенного бота — когда приложение не смогло стартовать. */
export function botApiSender(token: string) {
  return async (chatId: string, text: string) => {
    // сеть хостера пропускает к Telegram не каждое подключение — пробуем несколько раз
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Bot API ${res.status}`);
        return;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  };
}

export async function checkDisk(alert: Alert): Promise<void> {
  const fs = await statfs('/');
  const freeMb = Math.round((fs.bavail * fs.bsize) / 1024 / 1024);
  if (freeMb < LOW_DISK_MB) {
    await alert('disk', `на диске сервера осталось ${freeMb} МБ. Когда место кончается, база данных падает — нужно почистить диск или увеличить его.`);
  }
}
