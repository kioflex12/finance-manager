try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env необязателен — переменные могут прийти из окружения
}

const env = process.env;

export const config = {
  botToken: env.BOT_TOKEN ?? '',
  botUsername: env.BOT_USERNAME ?? '',
  webappUrl: env.WEBAPP_URL ?? '',
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? '',
  llmEnabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  llmModel: env.LLM_MODEL ?? 'claude-opus-5-5',
  sttBaseUrl: env.STT_BASE_URL ?? '',
  sttApiKey: env.STT_API_KEY ?? '',
  sttModel: env.STT_MODEL ?? '',
  devTgId: env.NODE_ENV === 'production' ? '' : (env.DEV_TG_ID ?? ''),
};
