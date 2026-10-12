import { config } from '../config.js';

export type Transcriber = (audio: Uint8Array, filename: string) => Promise<string>;

/** Распознавание через OpenAI-совместимый /audio/transcriptions; null, если сервис не настроен. */
export function createTranscriber(): Transcriber | null {
  if (!config.sttBaseUrl || !config.sttModel) return null;
  return async (audio, filename) => {
    const form = new FormData();
    form.append('file', new Blob([audio as BlobPart]), filename);
    form.append('model', config.sttModel);
    form.append('language', 'ru');
    const res = await fetch(`${config.sttBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: config.sttApiKey ? { Authorization: `Bearer ${config.sttApiKey}` } : {},
      body: form,
    });
    if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  };
}
