// Локальная разработка: публичный HTTPS-адрес для миниаппа через serveo.net.
// Без регистрации адрес случайный и меняется при переподключении, поэтому при каждой
// смене он записывается в .data/tunnel-url (его читает сервер) и в кнопку меню бота.
// Постоянный адрес: зарегистрировать SSH-ключ на console.serveo.net и задать TUNNEL_SUBDOMAIN.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // .env необязателен
}

const PORT = process.env.PORT ?? '3000';
const TOKEN = process.env.BOT_TOKEN;
const URL_FILE = new URL('../.data/tunnel-url', import.meta.url);
const SUBDOMAIN = process.env.TUNNEL_SUBDOMAIN;
const URL_PATTERN = /https:\/\/(?!console\.)[a-z0-9-]+\.(?:serveousercontent\.com|serveo\.net)/g;
const RESTART_DELAY_MS = 5000;

let current = '';

async function publish(url) {
  if (url === current) return;
  current = url;
  mkdirSync(new URL('.', URL_FILE), { recursive: true });
  writeFileSync(URL_FILE, url);
  console.log(`[tunnel] ${url}`);
  if (!TOKEN) return;
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Трекер', web_app: { url } } }),
  });
  if (!res.ok) console.error('[tunnel] не удалось обновить кнопку меню:', await res.text());
}

function connect() {
  const ssh = spawn(
    'ssh',
    ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `${SUBDOMAIN ? `${SUBDOMAIN}:` : ''}80:localhost:${PORT}`, 'serveo.net'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  ssh.stdout.on('data', (chunk) => {
    const url = String(chunk).match(URL_PATTERN)?.at(-1);
    if (url) publish(url).catch((err) => console.error('[tunnel]', err));
  });
  ssh.on('exit', (code) => {
    console.error(`[tunnel] ssh завершился (${code}), переподключаюсь`);
    setTimeout(connect, RESTART_DELAY_MS);
  });
}

connect();
