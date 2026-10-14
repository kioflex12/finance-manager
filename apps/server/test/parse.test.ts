import { describe, expect, it } from 'vitest';
import { formatMoney, quickParse, ruleKey } from '../src/core/parse.js';

describe('quickParse', () => {
  it.each([
    ['400 продукты', 40000, 'продукты'],
    ['такси 250', 25000, 'такси'],
    ['запиши 400 рублей на продукты', 40000, 'продукты'],
    ['Запиши 400р на продукты.', 40000, 'продукты'],
    ['кофе 199,90', 19990, 'кофе'],
    ['аренда 1 200', 120000, 'аренда'],
    ['ноутбук 1.5к', 150000, 'ноутбук'],
    ['2 тыс подарок маме', 200000, 'подарок маме'],
    ['350 ₽ обед', 35000, 'обед'],
    ['400', 40000, ''],
  ])('%s', (text, amount, description) => {
    expect(quickParse(text)).toEqual({ amount, description });
  });

  it.each(['400 продукты и 250 такси', 'четыреста на продукты', 'привет', '', '0 ничего', '400 кофе\n250 такси'])(
    'оставляет LLM: %s',
    (text) => {
      expect(quickParse(text)).toBeNull();
    },
  );
});

it('ruleKey сводит варианты написания к одному ключу', () => {
  expect(ruleKey('  Пятёрочка! ')).toBe(ruleKey('пятерочка'));
});

it('formatMoney', () => {
  expect(formatMoney(1240000)).toBe('12 400 ₽');
  expect(formatMoney(19990)).toBe('199,90 ₽');
  expect(formatMoney(0)).toBe('0 ₽');
});

it('displayName приводит название траты к единому виду', async () => {
  const { displayName } = await import('../src/core/service.js');
  expect(displayName('кофе')).toBe('Кофе');
  expect(displayName('  бизнес   ланч!! ')).toBe('Бизнес ланч');
  expect(displayName('Яндекс Плюс')).toBe('Яндекс Плюс');
  expect(displayName('ёлка')).toBe('Ёлка');
  expect(displayName('...')).toBe('');
});
