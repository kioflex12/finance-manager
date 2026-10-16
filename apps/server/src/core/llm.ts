import { z } from 'zod';

export interface ParsedOp {
  /** рубли, возможны копейки дробью */
  amount: number;
  description: string;
  /** позиция: каноническое название траты («кофе» для «кофеёчек») */
  item?: string;
  category: string;
}

export interface ParseInput {
  text: string;
  categories: string[];
  /** выученные соответствия «описание → категория» этой комнаты */
  hints: { description: string; category: string }[];
  /** позиции, которые уже есть в комнате, — чтобы модель переиспользовала их названия */
  items: string[];
}

export interface ExpenseParser {
  /** Разбирает сообщение на траты с суммами. */
  parse(input: ParseInput): Promise<ParsedOp[]>;
  /** Подбирает категорию для описания уже записанной траты; null — модель не ответила внятно. */
  categorize(input: ParseInput): Promise<{ category: string; item?: string } | null>;
  /** Какие позиции журнала — разновидности других позиций из того же списка: «Лимонад» → «Напитки». */
  groupItems(items: string[], categories: string[]): Promise<ItemMerge[]>;
}

export interface ItemMerge {
  from: string;
  to: string;
}

export interface LlmOptions {
  /** OpenAI-совместимый адрес, например https://api.mistral.ai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

const Operations = z.object({
  operations: z.array(
    z.object({
      amount: z.coerce.number(),
      description: z.string(),
      item: z.string().optional(),
      category: z.string(),
    }),
  ),
});

const TIMEOUT_MS = 15_000;

const HINTS_NOTE = 'Примеры из блока «Как он уже относил траты» важнее твоих собственных догадок: это исправления пользователя.';

const ITEM_RULE =
  'позиция: то же самое, но в обычной словарной форме, чтобы одинаковые траты сложились вместе. Убери уменьшительные формы, сленг и лишние уточнения: «кофеёчек», «кофе с собой», «кофеек» → «Кофе»; «таксишка», «такси домой» → «Такси». Одно-два слова в обычной словарной форме, с большой буквы: «Кофе», «Такси», «Бизнес-ланч»; бренды и названия — как они пишутся официально: «Яндекс Плюс», «Пятёрочка». Позиция — общий признак, а не подробности: формат, место, сорт и уточнения отбрасывай («капитанский стол мафия» → «Мафия», «обед в столовой» → «Обед»). Если в блоке «Уже есть позиции» есть та, разновидностью которой является трата, — возьми её название буква в букву: при существующей «Напитки» лимонад, кола и вода — это «Напитки»; при существующей «Кофе» капучино и латте — это «Кофе». Если подходят несколько — бери самую узкую. Разные вещи не объединяй: «Кофе» и «Чай» — разные позиции. Не сводит позицию к названию категории: сыр и овощи — это «Сыр» и «Овощи», а не «Продукты».';

const PARSE_SYSTEM = `Ты разбираешь сообщения пользователя трекера расходов. Сообщение — это текст или расшифровка голосового на русском, в котором человек называет одну или несколько трат.

Ответь только JSON-объектом вида {"operations": [{"amount": 400, "description": "кофеёчек", "item": "Кофе", "category": "Кафе и рестораны"}]}.

Для каждой операции:
- amount — сумма в рублях числом. Суммы словами («четыреста», «полторы тысячи», «5к») переведи в число.
- description — короткое описание траты в нижнем регистре, как сказал бы сам пользователь («продукты», «такси до аэропорта»). Без суммы и слов вроде «запиши».
- item — ${ITEM_RULE}
- category — ровно одно название из списка категорий в сообщении. Если ничего не подходит — «Другое».

${HINTS_NOTE}
Если в сообщении нет трат с суммой — верни {"operations": []}. Ничего не выдумывай.`;

const CATEGORIZE_SYSTEM = `Ты относишь трату пользователя трекера расходов к категории и называешь её позицию. В сообщении — список категорий и короткое описание траты на русском: товар, услуга, название магазина или сервиса.

Ответь только JSON-объектом вида {"category": "Кафе и рестораны", "item": "Кофе"}:
- category — ровно одно название из списка категорий. Если ничего не подходит — «Другое».
- item — ${ITEM_RULE}

${HINTS_NOTE}`;

const GROUP_SYSTEM = `Ты наводишь порядок в позициях трат одного журнала расходов. Позиция — то, на что тратили: «Кофе», «Такси», «Напитки».

Найди позиции, которые являются разновидностью другой позиции из этого же списка, и верни их только JSON-объектом вида {"merges": [{"from": "Лимонад", "to": "Напитки"}]}.

Правила:
- from — разновидность или частный случай to: лимонад, кола, вода → «Напитки»; капучино, латте → «Кофе»; «Капитанский стол мафия» → «Мафия».
- Оба названия — буква в букву из списка. Если подходят несколько to — бери самую узкую.
- Не объединяй разные вещи одного уровня: «Кофе» и «Чай», «Такси» и «Автобус» — разные позиции.
- to — только название из этого списка позиций. Не придумывай общих групп, которых в списке нет: «Такси» и «Автобус» без позиции «Транспорт» в списке так и остаются.
- Не своди конкретное к слишком общему: сыр и овощи остаются «Сыр» и «Овощи», даже если в списке есть «Продукты».
- Магазины и бренды («Пятёрочка», «Ермолино», «Бургер кинг») не сливай с товарами.
- Обычно объединять нечего — тогда верни {"merges": []}. Сомневаешься — не объединяй.`;

/** Разбор через любой OpenAI-совместимый /chat/completions (Mistral, Groq, OpenRouter, Ollama…). */
export function createLlmParser({ baseUrl, apiKey, model }: LlmOptions, fetchFn: typeof fetch = fetch): ExpenseParser {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function ask(system: string, label: string, { text, categories, hints, items }: ParseInput): Promise<string> {
    const hintBlock =
      (hints.length ? `\n\nКак он уже относил траты:\n${hints.map((h) => `${h.description} → ${h.category}`).join('\n')}` : '') +
      (items.length ? `\n\nУже есть позиции: ${items.join(', ')}` : '');
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${categories.length ? `Категории: ${categories.join(', ')}` : ''}${hintBlock}\n\n${label}:\n${text}`.trim() },
        ],
      }),
    });
    // бесплатные тарифы упираются в лимиты (429) — вызывающий код переживает это без LLM
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  return {
    parse: async (input) => parseReply(await ask(PARSE_SYSTEM, 'Сообщение', input)),
    categorize: async (input) => parseCategory(await ask(CATEGORIZE_SYSTEM, 'Трата', input)),
    // категории в этот запрос не передаём: модель принимала их за цели слияния («Такси» → «Транспорт»);
    // слияние в название категории всё равно отсекается при проверке ответа
    groupItems: async (items) => parseMerges(await ask(GROUP_SYSTEM, 'Позиции', { text: items.join('\n'), categories: [], hints: [], items: [] })),
  };
}

/** Модели иногда оборачивают JSON в ```-блок или добавляют пояснение — берём сам объект. */
function jsonObject(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseReply(content: string): ParsedOp[] {
  const parsed = Operations.safeParse(jsonObject(content));
  return parsed.success ? parsed.data.operations.filter((op) => Number.isFinite(op.amount)) : [];
}

const ItemMerges = z.object({ merges: z.array(z.object({ from: z.string(), to: z.string() })) });

export function parseMerges(content: string): ItemMerge[] {
  const parsed = ItemMerges.safeParse(jsonObject(content));
  return parsed.success ? parsed.data.merges : [];
}

export function parseCategory(content: string): { category: string; item?: string } | null {
  const parsed = z.object({ category: z.string(), item: z.string().optional() }).safeParse(jsonObject(content));
  return parsed.success ? parsed.data : null;
}
