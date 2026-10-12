import { readFileSync } from 'node:fs';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env необязателен — переменные могут прийти из окружения
}

const env = process.env;
const TUNNEL_URL_FILE = new URL('../../../.data/tunnel-url', import.meta.url);

export const config = {
  botToken: env.BOT_TOKEN ?? '',
  botUsername: env.BOT_USERNAME ?? '',
  /** Адрес миниаппа: из окружения, а при локальной разработке — из файла, который обновляет scripts/tunnel.mjs. */
  get webappUrl(): string {
    if (env.WEBAPP_URL) return env.WEBAPP_URL;
    try {
      return readFileSync(TUNNEL_URL_FILE, 'utf8').trim();
    } catch {
      return '';
    }
  },
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? '',
  llmBaseUrl: env.LLM_BASE_URL ?? '',
  llmApiKey: env.LLM_API_KEY ?? '',
  llmModel: env.LLM_MODEL ?? '',
  // по умолчанию голос распознаёт тот же провайдер, что и LLM
  sttBaseUrl: env.STT_BASE_URL || env.LLM_BASE_URL || '',
  sttApiKey: env.STT_API_KEY || env.LLM_API_KEY || '',
  sttModel: env.STT_MODEL ?? '',
  devTgId: env.NODE_ENV === 'production' ? '' : (env.DEV_TG_ID ?? ''),
};
