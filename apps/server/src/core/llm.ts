import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
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

const Output = z.object({
  operations: z.array(
    z.object({
      amount: z.number(),
      description: z.string(),
      category: z.string(),
    }),
  ),
});

const SYSTEM = `Ты разбираешь сообщения пользователя трекера расходов. Сообщение — это текст или расшифровка голосового на русском, в котором человек называет одну или несколько трат.

Верни список операций. Для каждой:
- amount — сумма в рублях числом. Суммы словами («четыреста», «полторы тысячи», «5к») переведи в число.
- description — короткое описание траты в нижнем регистре, как сказал бы сам пользователь («продукты», «такси до аэропорта»). Без суммы и слов вроде «запиши».
- category — ровно одно название из списка категорий в сообщении. Если ничего не подходит — «Другое».

Примеры пользователя из блока «Как он уже относил траты» важнее твоих собственных догадок: это его исправления.
Если в сообщении нет трат с суммой — верни пустой список. Ничего не выдумывай.`;

export function createClaudeParser(model: string): ExpenseParser {
  const client = new Anthropic();
  return {
    async parse({ text, categories, hints }) {
      const hintBlock = hints.length
        ? `\n\nКак он уже относил траты:\n${hints.map((h) => `${h.description} → ${h.category}`).join('\n')}`
        : '';
      const response = await client.messages.parse({
        model,
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Категории: ${categories.join(', ')}${hintBlock}\n\nСообщение:\n${text}`,
          },
        ],
        output_config: { effort: 'low', format: zodOutputFormat(Output) },
      });
      if (response.stop_reason === 'refusal') return [];
      return response.parsed_output?.operations ?? [];
    },
  };
}
