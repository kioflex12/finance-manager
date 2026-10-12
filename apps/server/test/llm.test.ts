import { expect, it } from 'vitest';
import { createLlmParser, parseReply } from '../src/core/llm.js';

it('parseReply достаёт операции из чистого JSON, из ```-блока и терпит мусор', () => {
  const op = { amount: 400, description: 'продукты', category: 'Продукты' };
  expect(parseReply(JSON.stringify({ operations: [op] }))).toEqual([op]);
  expect(parseReply('```json\n{"operations":[{"amount":"400","description":"продукты","category":"Продукты"}]}\n```')).toEqual([op]);
  expect(parseReply('не знаю')).toEqual([]);
  expect(parseReply('{"operations": "нет"}')).toEqual([]);
  expect(parseReply('{broken')).toEqual([]);
});

it('шлёт запрос в /chat/completions с категориями и подсказками и разбирает ответ', async () => {
  let seen: { url: string; headers: Record<string, string>; body: any } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    return Response.json({ choices: [{ message: { content: '{"operations":[{"amount":250,"description":"такси","category":"Транспорт"}]}' } }] });
  }) as unknown as typeof fetch;

  const parser = createLlmParser({ baseUrl: 'https://llm.test/v1/', apiKey: 'k', model: 'm' }, fakeFetch);
  const ops = await parser.parse({
    text: 'двести пятьдесят на такси',
    categories: ['Транспорт', 'Другое'],
    hints: [{ description: 'яндекс', category: 'Транспорт' }],
  });

  expect(ops).toEqual([{ amount: 250, description: 'такси', category: 'Транспорт' }]);
  expect(seen!.url).toBe('https://llm.test/v1/chat/completions');
  expect(seen!.headers.authorization).toBe('Bearer k');
  expect(seen!.body.model).toBe('m');
  expect(seen!.body.messages[1].content).toContain('Категории: Транспорт, Другое');
  expect(seen!.body.messages[1].content).toContain('яндекс → Транспорт');
  expect(seen!.body.messages[1].content).toContain('двести пятьдесят на такси');
});

it('ошибка провайдера (например, лимит бесплатного тарифа) — исключение, а не пустой ответ', async () => {
  const limited = (async () => new Response('rate limit', { status: 429 })) as unknown as typeof fetch;
  const parser = createLlmParser({ baseUrl: 'https://llm.test/v1', apiKey: '', model: 'm' }, limited);
  await expect(parser.parse({ text: 'x', categories: [], hints: [] })).rejects.toThrow('LLM 429');
});
