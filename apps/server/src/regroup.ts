// Разовая пересборка позиций по смыслу во всех журналах: `node apps/server/dist/regroup.js`.
// Обычно не нужна — новые позиции пересобираются сами; пригодится после смены правил группировки.
import { config } from './config.js';
import { createLlmParser } from './core/llm.js';
import { groupItemsByMeaning, regroupItems, type App } from './core/service.js';
import { openDb } from './db.js';

const app: App = {
  db: await openDb(config.databaseUrl || undefined),
  llm: config.llmBaseUrl && config.llmModel ? createLlmParser({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel }) : null,
};
if (!app.llm) throw new Error('LLM не настроен — по смыслу сгруппировать нечем');

await regroupItems(app);
const rooms = await app.db.query<{ id: number; name: string }>(
  'SELECT DISTINCT r.id, r.name FROM rooms r JOIN operations o ON o.room_id = r.id ORDER BY r.id',
);
for (const room of rooms) {
  const before = await app.db.query<{ item: string }>('SELECT DISTINCT item FROM operations WHERE room_id = $1', [room.id]);
  const merged = await groupItemsByMeaning(app, room.id);
  console.log(`«${room.name}»: позиций ${before.length}, объединено ${merged}`);
}
await app.db.close();
