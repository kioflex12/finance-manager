import { z } from 'zod';

export interface ParsedOp {
  /** рубли, возможны копейки дробью */
  amount: number;
  description: string;
  category: string;
}

export interface ParseInput {
  text: string;
  categories: string[];
  /** выученные соответствия «описание → категория» этой комнаты */
  hints: { description: string; category: string }[];
}

export interface ExpenseParser {
  parse(input: ParseInput): Promise<ParsedOp[]>;
}

export interface LlmOptions {
  /** OpenAI-совместимый адрес, например https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

const Output = z.object({
  operations: z.array(
    z.object({
      amount: z.coerce.number(),
      description: z.string(),
      category: z.string(),
    }),
  ),
});

const TIMEOUT_MS = 15_000;

const SYSTEM = `Ты разбираешь сообщения пользователя трекера расходов. Сообщение — это текст или расшифровка голосового на русском, в котором человек называет одну или несколько трат.

Ответь только JSON-объектом вида {"operations": [{"amount": 400, "description": "продукты", "category": "Продукты"}]}.

Для каждой операции:
- amount — сумма в рублях числом. Суммы словами («четыреста», «полторы тысячи», «5к») переведи в число.
- description — короткое описание траты в нижнем регистре, как сказал бы сам пользователь («продукты», «такси до аэропорта»). Без суммы и слов вроде «запиши».
- category — ровно одно название из списка категорий в сообщении. Если ничего не подходит — «Другое».

Примеры из блока «Как он уже относил траты» важнее твоих собственных догадок: это исправления пользователя.
Если в сообщении нет трат с суммой — верни {"operations": []}. Ничего не выдумывай.`;

/** Разбор через любой OpenAI-совместимый /chat/completions (Groq, OpenRouter, Gemini, Ollama…). */
export function createLlmParser({ baseUrl, apiKey, model }: LlmOptions, fetchFn: typeof fetch = fetch): ExpenseParser {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  return {
    async parse({ text, categories, hints }) {
      const hintBlock = hints.length
        ? `\n\nКак он уже относил траты:\n${hints.map((h) => `${h.description} → ${h.category}`).join('\n')}`
        : '';
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Категории: ${categories.join(', ')}${hintBlock}\n\nСообщение:\n${text}` },
          ],
        }),
      });
      // бесплатные тарифы упираются в лимиты (429) — вызывающий код переживает это без LLM
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return parseReply(data.choices?.[0]?.message?.content ?? '');
    },
  };
}

/** Модели иногда оборачивают JSON в ```-блок или добавляют пояснение — берём сам объект. */
export function parseReply(content: string): ParsedOp[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return [];
  try {
    const parsed = Output.safeParse(JSON.parse(content.slice(start, end + 1)));
    return parsed.success ? parsed.data.operations.filter((op) => Number.isFinite(op.amount)) : [];
  } catch {
    return [];
  }
}
