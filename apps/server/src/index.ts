import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './api.js';
import { createBot, startJobs } from './bot.js';
import { config } from './config.js';
import { createClaudeParser } from './core/llm.js';
import type { App } from './core/service.js';
import { createTranscriber } from './core/stt.js';
import { openDb } from './db.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MINIAPP_DIST = path.join(ROOT, 'apps/miniapp/dist');

const app: App = {
  db: await openDb(config.databaseUrl || undefined, path.join(ROOT, '.data/pg')),
  llm: config.llmEnabled ? createClaudeParser(config.llmModel) : null,
};
if (!app.llm) console.warn('ANTHROPIC_API_KEY не задан: работает только быстрый разбор вида «400 продукты»');

const http = new Hono();
http.route('/', createApi(app));
if (existsSync(MINIAPP_DIST)) {
  const root = path.relative(process.cwd(), MINIAPP_DIST);
  http.use('*', serveStatic({ root }));
  http.get('*', serveStatic({ root, path: 'index.html' }));
}
serve({ fetch: http.fetch, port: config.port }, () => console.log(`http://localhost:${config.port}`));

if (config.botToken) {
  const bot = createBot(app, createTranscriber());
  startJobs(app, bot);
  void bot.start({ onStart: (me) => console.log(`bot @${me.username} запущен`) });
} else {
  console.warn('BOT_TOKEN не задан: бот и рассылка сводок выключены, работает только API');
}
