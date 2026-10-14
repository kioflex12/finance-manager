import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { config } from './config.js';
import { formatMoney, quickParse } from './core/parse.js';
import * as s from './core/service.js';
import type { Transcriber } from './core/stt.js';
import { operationLine, reportText, summaryText, totalsLine } from './core/text.js';

const HELP = `Просто напиши трату — например «400 продукты» или «такси 250». Можно несколько сразу или голосовым.
Траты идут в активный журнал — его название видно под каждой записью. Записать в другой: «в отпуск: 400 такси».

/summary — сколько потрачено за период
/rooms — переключить журнал
/invite — пригласить в журнал`;

export function createBot(app: s.App, transcribe: Transcriber | null): Bot {
  const bot = new Bot(config.botToken);

  const userOf = (ctx: Context) =>
    s.ensureUser(app, {
      id: ctx.from!.id,
      name: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' '),
    });

  // заблокированные в админке пользователи для бота не существуют
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot && (await userOf(ctx)).blocked) return;
    await next();
  });

  const isGroup = (ctx: Context) => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  const roomOf = (ctx: Context, user: s.User) =>
    isGroup(ctx)
      ? s.ensureGroupRoom(app, { id: ctx.chat!.id, title: ctx.chat!.title ?? 'Общий журнал' }, user)
      : s.ensureActiveRoom(app, user);

  function appKeyboard(ctx: Context, room: s.Room): InlineKeyboard | undefined {
    // кнопка web_app разрешена только в личных чатах; в группах — ссылка на миниапп
    if (!isGroup(ctx)) return config.webappUrl ? new InlineKeyboard().webApp('Открыть трекер', config.webappUrl) : undefined;
    return config.botUsername
      ? new InlineKeyboard().url('Открыть трекер', `https://t.me/${config.botUsername}?startapp=room_${room.id}`)
      : undefined;
  }

  /** Кнопки под записанной тратой; перенос в другой журнал — только если у пользователя их несколько. */
  async function opKeyboard(ctx: Context, opId: number): Promise<InlineKeyboard> {
    const keyboard = new InlineKeyboard().text('✏️ Категория', `cat:${opId}`).text('💰 Сумма', `amt:${opId}`).row();
    if (!isGroup(ctx) && (await s.listRooms(app, (await userOf(ctx)).id)).length > 1) keyboard.text('📒 Журнал', `mv:${opId}`);
    return keyboard.text('↩️ Отменить', `del:${opId}`);
  }

  /** Номер траты из кнопок под сообщением бота — так ответ на запись понимает, к какой трате он относится. */
  function opIdOf(message: { reply_markup?: InlineKeyboardMarkup }): number | null {
    for (const button of message.reply_markup?.inline_keyboard.flat() ?? []) {
      const match = /^(?:cat|amt|del):(\d+)$/.exec('callback_data' in button ? button.callback_data : '');
      if (match) return Number(match[1]);
    }
    return null;
  }

  async function changeAmount(ctx: Context & { message: { reply_to_message?: { message_id: number } } }, opId: number, amount: number) {
    const op = await s.getOperation(app, opId);
    const user = await userOf(ctx);
    if (!op || !(await s.isMember(app, op.roomId, user.id))) {
      await ctx.reply('Эта трата уже удалена.');
      return;
    }
    const updated = await s.setAmount(app, op, amount);
    if (!updated) {
      await ctx.reply('Такую сумму записать не получится.');
      return;
    }
    const room = (await s.getRoom(app, op.roomId))!;
    // обновляем саму запись, чтобы в чате не оставалась старая сумма
    await ctx.api
      .editMessageText(ctx.chat!.id, ctx.message.reply_to_message!.message_id, `${operationLine(updated)}\n${await footer(ctx, room)}`, {
        reply_markup: await opKeyboard(ctx, op.id),
      })
      .catch(() => {});
    await ctx.reply(`✅ Сумма исправлена: ${formatMoney(op.amount)} → ${formatMoney(updated.amount)}`);
  }

  async function footer(ctx: Context, room: s.Room): Promise<string> {
    const period = await s.currentPeriod(app, room.id);
    if (!period) return '';
    const stats = await s.periodStats(app, period.id);
    const totals = totalsLine(stats, s.budgetInfo(room, period, stats.total));
    return isGroup(ctx) ? totals : `«${room.name}» · ${totals}`;
  }

  async function record(ctx: Context, text: string, opts: { quiet?: boolean; heard?: string } = {}): Promise<void> {
    const user = await userOf(ctx);
    // в личном чате журнал можно назвать прямо в сообщении: «в отпуск: 400 такси»; иначе — активный
    const named = isGroup(ctx) ? null : s.pickRoom(text, await s.listRooms(app, user.id));
    const room = named?.room ?? (await roomOf(ctx, user));
    const result = await s.addFromText(app, room, user, named?.rest ?? text);

    if (result.status === 'no_period') {
      await ctx.reply(`Срок журнала «${room.name}» закончился.`, {
        reply_markup: new InlineKeyboard().text('Начать новый период', `np:${room.id}`),
      });
      return;
    }
    if (result.status === 'not_understood') {
      if (!opts.quiet) await ctx.reply('Не нашёл сумму. Напиши, например: «400 продукты».');
      return;
    }

    const tail = await footer(ctx, room);
    const head = opts.heard ? `🎙 «${opts.heard}»\n` : '';
    for (const [i, op] of result.ops.entries()) {
      const last = i === result.ops.length - 1;
      const compose = (o: s.Operation) => `${i === 0 ? head : ''}${operationLine(o)}${last ? '\n' + tail : ''}`;
      const keyboard = await opKeyboard(ctx, op.id);
      const sent = await ctx.reply(compose(op), { reply_markup: keyboard });
      if (result.pendingOpId === op.id) {
        const done = await s.categorizePending(app, op.id);
        // null — трату успели отменить, пока подбиралась категория
        if (done) await ctx.api.editMessageText(sent.chat.id, sent.message_id, compose(done), { reply_markup: keyboard });
      }
    }
  }

  bot.command('start', async (ctx) => {
    const user = await userOf(ctx);
    if (isGroup(ctx)) {
      const room = await roomOf(ctx, user);
      await ctx.reply(
        `Журнал «${room.name}» готов. Пишите траты прямо сюда, начиная с суммы: «400 продукты». Итоги периода пришлю в этот чат.`,
        { reply_markup: appKeyboard(ctx, room) },
      );
      return;
    }
    if (ctx.match.startsWith('join_')) {
      const joined = await s.joinRoom(app, user, ctx.match.slice(5));
      await ctx.reply(
        joined ? `Ты в журнале «${joined.name}». Траты теперь записываются в него.` : 'Приглашение не найдено или устарело.',
        joined ? { reply_markup: appKeyboard(ctx, joined) } : {},
      );
      return;
    }
    const room = await s.ensureActiveRoom(app, user);
    await ctx.reply(`Привет! Я записываю расходы.\n\n${HELP}`, { reply_markup: appKeyboard(ctx, room) });
  });

  bot.command('help', (ctx) => ctx.reply(HELP));

  bot.command('summary', async (ctx) => {
    const room = await roomOf(ctx, await userOf(ctx));
    const period = await s.currentPeriod(app, room.id);
    if (!period) {
      await ctx.reply(`Срок журнала «${room.name}» закончился.`, {
        reply_markup: new InlineKeyboard().text('Начать новый период', `np:${room.id}`),
      });
      return;
    }
    const stats = await s.periodStats(app, period.id);
    await ctx.reply(reportText(room, period, stats, s.budgetInfo(room, period, stats.total)), {
      reply_markup: appKeyboard(ctx, room),
    });
  });

  bot.command('rooms', async (ctx) => {
    if (isGroup(ctx)) return;
    const user = await userOf(ctx);
    const active = await s.ensureActiveRoom(app, user);
    const keyboard = new InlineKeyboard();
    for (const room of await s.listRooms(app, user.id)) {
      keyboard.text(`${room.id === active.id ? '● ' : ''}${room.name}`, `room:${room.id}`).row();
    }
    await ctx.reply('В какой журнал записывать траты?', { reply_markup: keyboard });
  });

  bot.command('invite', async (ctx) => {
    const room = await roomOf(ctx, await userOf(ctx));
    await ctx.reply(
      config.botUsername
        ? `Приглашение в «${room.name}»:\nhttps://t.me/${config.botUsername}?start=join_${room.inviteCode}`
        : 'Не задан BOT_USERNAME — ссылку собрать не из чего.',
    );
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    // ответ на запись бота одной суммой — исправление суммы этой траты
    const repliedOp = ctx.message.reply_to_message?.from?.id === ctx.me.id ? opIdOf(ctx.message.reply_to_message) : null;
    const newAmount = quickParse(text);
    if (repliedOp && newAmount && !newAmount.description) return changeAmount(ctx, repliedOp, newAmount.amount);
    if (!isGroup(ctx)) return record(ctx, text);

    // В общем чате полно обычной переписки: без обращения к боту берём только «сумма + описание»
    const mention = `@${ctx.me.username}`;
    const addressed = ctx.message.reply_to_message?.from?.id === ctx.me.id || text.includes(mention);
    if (addressed) return record(ctx, text.replaceAll(mention, '').trim());
    if (/^\d/.test(text.trim()) && quickParse(text)?.description) return record(ctx, text, { quiet: true });
  });

  bot.on('message:voice', async (ctx) => {
    if (isGroup(ctx)) return;
    if (!transcribe) {
      await ctx.reply('Голосовой ввод пока не подключён — напиши текстом.');
      return;
    }
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
    const heard = await transcribe(new Uint8Array(await res.arrayBuffer()), 'voice.ogg');
    if (!heard) {
      await ctx.reply('Не расслышал. Попробуй ещё раз или напиши текстом.');
      return;
    }
    await record(ctx, heard, { heard });
  });

  /** Операция из callback-кнопки — только если нажавший состоит в её комнате. */
  async function opFor(ctx: Context, id: string | undefined): Promise<s.Operation | null> {
    const op = await s.getOperation(app, Number(id));
    const user = await userOf(ctx);
    if (!op || !(await s.isMember(app, op.roomId, user.id))) {
      await ctx.answerCallbackQuery({ text: 'Запись не найдена' });
      return null;
    }
    return op;
  }

  async function showOperation(ctx: Context, op: s.Operation): Promise<void> {
    const room = (await s.getRoom(app, op.roomId))!;
    await ctx.editMessageText(`${operationLine(op)}\n${await footer(ctx, room)}`, { reply_markup: await opKeyboard(ctx, op.id) });
  }

  bot.callbackQuery(/^mv:(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    const keyboard = new InlineKeyboard();
    for (const room of await s.listRooms(app, (await userOf(ctx)).id)) {
      if (room.id !== op.roomId) keyboard.text(`${room.emoji ?? '📒'} ${room.name}`, `mvto:${op.id}:${room.id}`).row();
    }
    keyboard.text('← Назад', `back:${op.id}`);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    await ctx.answerCallbackQuery({ text: 'В какой журнал перенести?' });
  });

  bot.callbackQuery(/^mvto:(\d+):(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    const target = await s.getRoom(app, Number(ctx.match[2]));
    if (!target || !(await s.isMember(app, target.id, (await userOf(ctx)).id))) {
      return void (await ctx.answerCallbackQuery({ text: 'Журнал не найден' }));
    }
    const moved = await s.moveOperation(app, op, target);
    if (moved) await showOperation(ctx, moved);
    await ctx.answerCallbackQuery({ text: moved ? `Перенёс в «${target.name}»` : `Срок журнала «${target.name}» закончился` });
  });

  bot.callbackQuery(/^amt:(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    await ctx.answerCallbackQuery({
      text: `Ответь на это сообщение новой суммой — например «${Math.round(op.amount / 100) + 50}»`,
      show_alert: true,
    });
  });

  bot.callbackQuery(/^cat:(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    const keyboard = new InlineKeyboard();
    for (const [i, c] of (await s.listCategories(app, op.roomId)).entries()) {
      keyboard.text(`${c.emoji} ${c.name}`, `set:${op.id}:${c.id}`);
      if (i % 2) keyboard.row();
    }
    keyboard.row().text('← Назад', `back:${op.id}`);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^set:(\d+):(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    const updated = await s.setCategory(app, op, Number(ctx.match[2]));
    if (updated) await showOperation(ctx, updated);
    await ctx.answerCallbackQuery({ text: updated ? 'Запомнил — дальше так и буду относить' : 'Категория не найдена' });
  });

  bot.callbackQuery(/^back:(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    await ctx.editMessageReplyMarkup({ reply_markup: await opKeyboard(ctx, op.id) });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const op = await opFor(ctx, ctx.match[1]);
    if (!op) return;
    await s.deleteOperation(app, op.id);
    await ctx.editMessageText(`↩️ Отменено: ${formatMoney(op.amount)} · ${op.item}`);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^room:(\d+)$/, async (ctx) => {
    const user = await userOf(ctx);
    const room = await s.getRoom(app, Number(ctx.match[1]));
    if (!room || !(await s.isMember(app, room.id, user.id))) return void (await ctx.answerCallbackQuery({ text: 'Журнал не найден' }));
    await s.setActiveRoom(app, user, room.id);
    await ctx.editMessageText(`Записываю в «${room.name}».`);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^np:(\d+)$/, async (ctx) => {
    const user = await userOf(ctx);
    const room = await s.getRoom(app, Number(ctx.match[1]));
    if (!room || !(await s.isMember(app, room.id, user.id))) return void (await ctx.answerCallbackQuery({ text: 'Журнал не найден' }));
    await s.startNewPeriod(app, room);
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Новый период в «${room.name}» начат. Можно записывать траты.`);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('rem:off', async (ctx) => {
    await s.setReminders(app, (await userOf(ctx)).id, false);
    await ctx.editMessageText('Больше не напоминаю.');
    await ctx.answerCallbackQuery();
  });

  bot.catch((err) => console.error('bot error', err.error));
  return bot;
}

/** Раз в минуту: закрывает истёкшие периоды, рассылает сводки и вечерние напоминания. */
export function startJobs(app: s.App, bot: Bot): NodeJS.Timeout {
  const send = (chatId: string, text: string, keyboard?: InlineKeyboard) =>
    // чат мог заблокировать бота — это не повод ронять рассылку остальным
    bot.api.sendMessage(chatId, text, { reply_markup: keyboard }).catch((err) => console.error('send failed', chatId, err));

  const tick = async () => {
    for (const closed of await s.closeDuePeriods(app)) {
      // пустой период — не повод писать человеку
      if (!closed.stats.count) continue;
      const keyboard = closed.renewed ? undefined : new InlineKeyboard().text('Начать новый период', `np:${closed.room.id}`);
      for (const chatId of closed.chatIds) await send(chatId, summaryText(closed), keyboard);
    }
    for (const user of await s.dueReminders(app)) {
      await send(user.tgId, 'Сегодня трат не записано. Были расходы? Напиши, например: «400 продукты».',
        new InlineKeyboard().text('Не напоминать', 'rem:off'));
    }
  };
  return setInterval(() => void tick().catch((err) => console.error('jobs failed', err)), 60_000);
}
