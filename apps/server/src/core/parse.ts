export interface QuickParse {
  /** копейки */
  amount: number;
  description: string;
}

const LEAD = /^(запиши|записать|запись|добавь|добавить|потратила?|трата|расход)\s+/i;
// сумма, необязательный множитель («к», «тыс») и необязательная валюта («р», «руб», «₽»)
const NUMBER =
  /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(к|k|тыс\.?|тысяч[аи]?)?\s*(?:₽|руб(?:лей|ля|ль|\.)?|р\.?)?(?![\d\p{L}])/giu;

/**
 * Быстрый разбор без LLM для сообщений с одной суммой: «400 продукты», «такси 1.5к»,
 * «запиши 400 рублей на продукты». Всё сложнее (несколько трат, суммы словами) — null.
 */
export function quickParse(input: string): QuickParse | null {
  const text = input.trim().replace(LEAD, '');
  if (!text || text.includes('\n')) return null;

  const numbers = [...text.matchAll(NUMBER)];
  if (numbers.length !== 1) return null;
  const m = numbers[0]!;

  const whole = Number(m[1]!.replace(/[  ]/g, ''));
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0;
  const amount = Math.round((whole + frac) * (m[3] ? 1000 : 1) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_000_000_000) return null;

  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  const description = `${before} ${after}`
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(на|за)\s+/i, '')
    .replace(/[.,;:!]+$/, '')
    .trim();
  return { amount, description };
}

/** Ключ правила: одинаковые по смыслу описания должны совпадать посимвольно. */
export function ruleKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function formatMoney(kopecks: number): string {
  const rub = Math.trunc(kopecks / 100);
  const kop = Math.abs(kopecks % 100);
  const whole = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole}${kop ? ',' + String(kop).padStart(2, '0') : ''} ₽`;
}
