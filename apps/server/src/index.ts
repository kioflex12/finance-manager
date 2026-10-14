import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { createApi } from './api.js';
import { createBot, startJobs } from './bot.js';
import { config } from './config.js';
import { createLlmParser } from './core/llm.js';
import { measuredParser, measuredTranscriber } from './core/metrics.js';
import type { App } from './core/service.js';
import { createTranscriber } from './core/stt.js';
import { openDb } from './db.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MINIAPP_DIST = path.join(ROOT, 'apps/miniapp/dist');

const app: App = {
  db: await openDb(config.databaseUrl || undefined, path.join(ROOT, '.data/pg')),
  llm:
    config.llmBaseUrl && config.llmModel
      ? measuredParser(createLlmParser({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel }))
      : null,
};
if (!app.llm) console.warn('LLM_BASE_URL и LLM_MODEL не заданы: работает только быстрый разбор вида «400 продукты»');

const http = new Hono();
// поток событий нельзя сжимать: сжатие буферизует ответ, и события не доходили бы до клиента
const compressor = compress();
http.use((c, next) => (c.req.path.endsWith('/events') ? next() : compressor(c, next)));
http.route('/', createApi(app));
if (existsSync(MINIAPP_DIST)) {
  const root = path.relative(process.cwd(), MINIAPP_DIST);
  http.use('*', serveStatic({ root }));
  http.get('*', serveStatic({ root, path: 'index.html' }));
}
serve({ fetch: http.fetch, port: config.port }, () => console.log(`http://localhost:${config.port}`));

if (config.botToken) {
  const transcriber = createTranscriber();
  const bot = createBot(app, transcriber && measuredTranscriber(transcriber));
  app.send = async (chatId, text) => void (await bot.api.sendMessage(chatId, text));
  startJobs(app, bot);
  // кнопка миниаппа слева от поля ввода в чате с ботом
  if (config.webappUrl) {
    await bot.api
      .setChatMenuButton({ menu_button: { type: 'web_app', text: 'Трекер', web_app: { url: config.webappUrl } } })
      .catch((err) => console.error('menu button failed', err));
  }
  void bot.start({ onStart: (me) => console.log(`bot @${me.username} запущен`) });
} else {
  console.warn('BOT_TOKEN не задан: бот и рассылка сводок выключены, работает только API');
}
