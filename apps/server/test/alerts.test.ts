import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { createAlerts } from '../src/core/alerts.js';

beforeEach(() => rmSync(path.join(os.tmpdir(), 'finance-manager-alerts.json'), { force: true }));

it('оповещение уходит владельцу и не повторяется чаще раза в 6 часов', async () => {
  const sent: [string, string][] = [];
  let now = 1_000_000;
  const alert = createAlerts('42', async (chat, text) => void sent.push([chat, text]), () => now);

  await alert('disk', 'мало места');
  await alert('disk', 'мало места');
  await alert('db', 'нет базы');
  expect(sent.map(([chat, text]) => [chat, text.replace(/^⚠️ Finance Manager: /, '')])).toEqual([
    ['42', 'мало места'],
    ['42', 'нет базы'],
  ]);

  now += 6 * 3600_000 + 1;
  await alert('disk', 'мало места');
  expect(sent).toHaveLength(3);
});

it('без получателя оповещения выключены', async () => {
  const sent: string[] = [];
  await createAlerts('', async (_, text) => void sent.push(text))('disk', 'мало места');
  expect(sent).toEqual([]);
});
