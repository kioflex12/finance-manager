import { useCallback, useEffect, useState } from 'react';
import { ApiError, confirmAction, money, tg } from '../api';
import { Icon, RoomAvatar, Sheet, useBack } from '../ui';
import { adminApi, type AdminJournal, type AdminJournalDetails, type AdminStats, type AdminUser, type AdminUserDetails, type DailyPoint } from './api';

type Section = 'stats' | 'users' | 'journals' | 'broadcast';
type Fail = (err: unknown) => void;

const SECTIONS: [Section, string][] = [
  ['stats', 'Сводка'],
  ['users', 'Люди'],
  ['journals', 'Журналы'],
  ['broadcast', 'Рассылка'],
];

const ERRORS: Record<string, string> = {
  forbidden: 'Это действие недоступно',
  bot_offline: 'Бот сейчас не запущен',
  not_delivered: 'Не доставлено: пользователь, скорее всего, остановил бота',
  empty: 'Пустое сообщение',
};

/** Админка: статистика, люди, журналы и рассылка. Загружается отдельным файлом только для администратора. */
export default function Admin({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>('stats');
  const [notice, setNotice] = useState('');
  useBack(onClose);

  const fail = useCallback<Fail>((err) => {
    const code = err instanceof ApiError ? err.code : '';
    setNotice(ERRORS[code] ?? 'Что-то пошло не так');
    tg?.HapticFeedback?.notificationOccurred('error');
  }, []);
  const done = useCallback((text: string) => {
    setNotice(text);
    tg?.HapticFeedback?.notificationOccurred('success');
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <main className="page admin">
      <header className="topbar">
        <button className="icon-button" aria-label="Назад" onClick={onClose}>
          <Icon name="back" />
        </button>
      </header>
      <h1>Админка</h1>
      <div className="segmented four">
        {SECTIONS.map(([key, label]) => (
          <button key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>
            {label}
          </button>
        ))}
      </div>
      {section === 'stats' && <Stats fail={fail} />}
      {section === 'users' && <Users fail={fail} done={done} />}
      {section === 'journals' && <Journals fail={fail} done={done} />}
      {section === 'broadcast' && <Broadcast fail={fail} done={done} />}
      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

function since(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'сейчас';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return date(iso);
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days ? `${days} д ${hours} ч` : `${hours} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

// ---------- сводка ----------

function Stats({ fail }: { fail: Fail }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  useEffect(() => void adminApi.stats().then(setStats).catch(fail), [fail]);
  if (!stats) return <div className="center muted">Загрузка…</div>;
  const { users, journals, operations, server } = stats;

  return (
    <>
      <div className="stat-grid">
        <Stat label="Пользователей" value={String(users.total)} note={`+${users.new7} за неделю`} />
        <Stat label="Записывали сегодня" value={String(users.active.d1)} note={`${users.active.d7} за 7 дней`} />
        <Stat label="Трат сегодня" value={String(operations.count1)} note={money(operations.sum1)} />
        <Stat label="Трат за 30 дней" value={String(operations.count30)} note={money(operations.sum30)} />
        <Stat label="Журналов" value={String(journals.total)} note={`${journals.shared} общих · ${journals.groups} в группах`} />
        <Stat label="Заблокировано" value={String(users.blocked)} note={`заходили сегодня: ${users.seen1}`} />
      </div>

      <h3 className="section">Траты по дням</h3>
      <div className="card">
        <DailyBars data={stats.daily} pick={(d) => d.operations} describe={(d) => `${d.operations} ${plural(d.operations, 'трата', 'траты', 'трат')} · записывали ${d.active} чел.`} />
      </div>

      <h3 className="section">Новые пользователи</h3>
      <div className="card">
        <DailyBars data={stats.daily} pick={(d) => d.users} describe={(d) => `${d.users} ${plural(d.users, 'новый', 'новых', 'новых')}`} />
      </div>

      {stats.topItems.length > 0 && (
        <>
          <h3 className="section">Частые траты за 30 дней</h3>
          <ul className="card rows">
            {stats.topItems.map((t) => (
              <li key={t.item} className="static">
                <span className="grow">
                  <span className="title">{t.item}</span>
                  <small>
                    {t.count} {plural(t.count, 'раз', 'раза', 'раз')}
                  </small>
                </span>
                <b>{money(t.sum)}</b>
              </li>
            ))}
          </ul>
        </>
      )}

      {stats.topCategories.length > 0 && (
        <>
          <h3 className="section">Категории за 30 дней</h3>
          <ul className="card rows">
            {stats.topCategories.map((c) => (
              <li key={c.name} className="static">
                <span className="emoji-cell">{c.emoji}</span>
                <span className="grow">
                  <span className="title">{c.name}</span>
                  <small>
                    {c.count} {plural(c.count, 'трата', 'траты', 'трат')}
                  </small>
                </span>
                <b>{money(c.sum)}</b>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="section">Сервер</h3>
      <ul className="card rows">
        <Info label="Работает без перезапуска" value={uptime(server.uptimeSec)} />
        <Info label="Память приложения" value={`${server.appMemoryMb} МБ`} />
        <Info label="Свободно памяти" value={`${server.freeMemoryMb} из ${server.totalMemoryMb} МБ`} />
        {server.disk && <Info label="Свободно на диске" value={`${(server.disk.freeMb / 1024).toFixed(1)} из ${(server.disk.totalMb / 1024).toFixed(1)} ГБ`} />}
        {server.dbSizeMb !== null && <Info label="База данных" value={`${server.dbSizeMb} МБ`} />}
        <Info label="Нагрузка процессора" value={server.load.toFixed(2)} />
        <Info label="Запросов к LLM" value={`${server.llm.calls} · ошибок ${server.llm.failures} · ~${server.llm.avgMs} мс`} />
        <Info label="Распознаваний голоса" value={`${server.stt.calls} · ошибок ${server.stt.failures}`} />
      </ul>
      <p className="muted hint">Счётчики LLM и голоса — с последнего перезапуска сервера.</p>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat card">
      <span className="muted">{label}</span>
      <b>{value}</b>
      <small>{note}</small>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <li className="static info">
      <span className="grow">{label}</span>
      <b>{value}</b>
    </li>
  );
}

/** Столбики за 30 дней одним цветом; нажатие на столбик показывает день и значение. */
function DailyBars(props: { data: DailyPoint[]; pick: (d: DailyPoint) => number; describe: (d: DailyPoint) => string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const values = props.data.map(props.pick);
  const max = Math.max(1, ...values);
  const active = picked === null ? props.data.length - 1 : picked;
  const point = props.data[active];
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  return (
    <div className="daily">
      <div className="daily-caption">
        <b>{point ? label(point.day) : ''}</b>
        <span className="muted">{point ? props.describe(point) : ''}</span>
      </div>
      <div className="daily-bars" role="img" aria-label="Значения по дням за 30 дней">
        {props.data.map((d, i) => (
          <button
            key={d.day}
            className={i === active ? 'active' : ''}
            aria-label={`${label(d.day)}: ${props.describe(d)}`}
            onClick={() => {
              tg?.HapticFeedback?.selectionChanged();
              setPicked(i);
            }}
          >
            <span style={{ height: `${Math.max(values[i]! ? 6 : 0, (values[i]! / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="daily-axis muted">
        <span>{props.data[0] ? label(props.data[0].day) : ''}</span>
        <span>макс. {max}</span>
        <span>сегодня</span>
      </div>
    </div>
  );
}

// ---------- люди ----------

function Users({ fail, done }: { fail: Fail; done: (text: string) => void }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [opened, setOpened] = useState<number | null>(null);

  const load = useCallback(() => adminApi.users(query).then((r) => setUsers(r.users)).catch(fail), [query, fail]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя или Telegram id" />
      <ul className="card rows spaced">
        {users?.map((u) => (
          <li key={u.id} onClick={() => setOpened(u.id)}>
            <span className={u.blocked ? 'avatar small blocked' : 'avatar small'}>{u.name.charAt(0).toUpperCase()}</span>
            <span className="grow">
              <span className="title">
                {u.name} {u.blocked && <span className="tag">заблокирован</span>}
              </span>
              <small>
                {u.operations} {plural(u.operations, 'трата', 'траты', 'трат')} · был {since(u.lastSeenAt)}
              </small>
            </span>
            <b>{money(u.sum)}</b>
          </li>
        ))}
        {users?.length === 0 && <li className="empty">Никого не нашлось</li>}
      </ul>
      {opened !== null && (
        <UserSheet
          id={opened}
          onClose={() => setOpened(null)}
          onChanged={() => void load()}
          fail={fail}
          done={done}
        />
      )}
    </>
  );
}

function UserSheet(props: { id: number; onClose: () => void; onChanged: () => void; fail: Fail; done: (text: string) => void }) {
  const { id, fail, done } = props;
  const [details, setDetails] = useState<AdminUserDetails | null>(null);
  const [text, setText] = useState('');
  const load = useCallback(() => adminApi.user(id).then(setDetails).catch(fail), [id, fail]);
  useEffect(() => void load(), [load]);

  if (!details) return null;
  const { user } = details;

  async function toggleBlock() {
    const question = user.blocked ? `Разблокировать ${user.name}?` : `Заблокировать ${user.name}? Бот перестанет ему отвечать, приложение не откроется.`;
    if (!(await confirmAction(question))) return;
    await adminApi
      .block(user.id, !user.blocked)
      .then(() => done(user.blocked ? 'Разблокирован' : 'Заблокирован'))
      .then(load)
      .then(props.onChanged)
      .catch(fail);
  }

  async function remove() {
    if (!(await confirmAction(`Удалить ${user.name} и все его данные: журналы, где он владелец, и его траты в общих? Отменить нельзя.`))) return;
    await adminApi
      .deleteUser(user.id)
      .then(() => done('Пользователь удалён'))
      .then(props.onChanged)
      .then(props.onClose)
      .catch(fail);
  }

  async function send() {
    await adminApi
      .message(user.id, text)
      .then(() => {
        setText('');
        done('Сообщение отправлено');
      })
      .catch(fail);
  }

  return (
    <Sheet title={user.name} onClose={props.onClose}>
      <p className="muted">
        Telegram id {user.tgId} · с {date(user.createdAt)} · был {since(user.lastSeenAt)}
        {details.isAdmin && ' · администратор'}
      </p>
      <div className="stat-grid compact">
        <Stat label="Трат" value={String(user.operations)} note={money(user.sum)} />
        <Stat label="Журналов" value={String(user.journals)} note={`последняя трата ${date(user.lastOperationAt)}`} />
      </div>

      {details.journals.length > 0 && (
        <>
          <h3 className="section">Журналы</h3>
          <ul className="rows">
            {details.journals.map((j) => (
              <li key={j.id} className="static">
                <span className="grow">
                  <span className="title">
                    {j.emoji} {j.name}
                  </span>
                  <small>
                    {j.owner ? 'владелец' : 'участник'} · {j.members} {plural(j.members, 'участник', 'участника', 'участников')}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {details.recent.length > 0 && (
        <>
          <h3 className="section">Последние траты</h3>
          <ul className="rows">
            {details.recent.map((op) => (
              <li key={op.id} className="static">
                <span className="grow">
                  <span className="title">{op.item}</span>
                  <small>
                    {op.journal} · {date(op.createdAt)}
                  </small>
                </span>
                <b>{money(op.amount)}</b>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="section">Написать от имени бота</h3>
      <div className="form">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Текст сообщения" rows={3} />
        <button className="primary" disabled={!text.trim()} onClick={send}>
          Отправить
        </button>
      </div>

      {!details.isAdmin && (
        <div className="danger-zone">
          <button className="link danger" onClick={toggleBlock}>
            {user.blocked ? 'Разблокировать' : 'Заблокировать'}
          </button>
          <button className="link danger" onClick={remove}>
            Удалить пользователя и данные
          </button>
        </div>
      )}
    </Sheet>
  );
}

// ---------- журналы ----------

function Journals({ fail, done }: { fail: Fail; done: (text: string) => void }) {
  const [journals, setJournals] = useState<AdminJournal[] | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const load = useCallback(() => adminApi.journals().then((r) => setJournals(r.journals)).catch(fail), [fail]);
  useEffect(() => void load(), [load]);

  return (
    <>
      <ul className="card rows spaced">
        {journals?.map((j) => (
          <li key={j.id} onClick={() => setOpened(j.id)}>
            <RoomAvatar room={{ name: j.name, emoji: j.emoji, color: j.color as never }} />
            <span className="grow">
              <span className="title">
                {j.name} {j.group && <span className="tag">группа</span>}
              </span>
              <small>
                {j.owner} · {j.members} {plural(j.members, 'участник', 'участника', 'участников')} · {j.operations}{' '}
                {plural(j.operations, 'трата', 'траты', 'трат')}
              </small>
            </span>
            <b>{money(j.periodSum)}</b>
          </li>
        ))}
        {journals?.length === 0 && <li className="empty">Журналов пока нет</li>}
      </ul>
      <p className="muted hint">Сумма справа — за текущий период.</p>
      {opened !== null && <JournalSheet id={opened} onClose={() => setOpened(null)} onChanged={() => void load()} fail={fail} done={done} />}
    </>
  );
}

function JournalSheet(props: { id: number; onClose: () => void; onChanged: () => void; fail: Fail; done: (text: string) => void }) {
  const { id, fail, done } = props;
  const [details, setDetails] = useState<AdminJournalDetails | null>(null);
  useEffect(() => void adminApi.journal(id).then(setDetails).catch(fail), [id, fail]);
  if (!details) return null;
  const { room, stats } = details;

  async function remove() {
    if (!(await confirmAction(`Удалить журнал «${room.name}» со всеми тратами и историей? Отменить нельзя.`))) return;
    await adminApi
      .deleteJournal(room.id)
      .then(() => done('Журнал удалён'))
      .then(props.onChanged)
      .then(props.onClose)
      .catch(fail);
  }

  return (
    <Sheet title={`${room.emoji ?? ''} ${room.name}`.trim()} onClose={props.onClose}>
      <p className="muted">
        {room.periodKind === 'month' ? 'ежемесячный' : `на ${room.periodDays} дн.`} · {room.budget ? `бюджет ${money(room.budget)}` : 'без бюджета'} ·{' '}
        {details.periods.length} {plural(details.periods.length, 'период', 'периода', 'периодов')}
      </p>
      <p className="muted">Участники: {details.members.map((m) => m.name).join(', ')}</p>
      {stats && (
        <>
          <h3 className="section">Текущий период · {money(stats.total)}</h3>
          <ul className="rows">
            {stats.byCategory.map((c) => (
              <li key={c.category?.name ?? 'none'} className="static">
                <span className="emoji-cell">{c.category?.emoji ?? '⏳'}</span>
                <span className="grow">
                  <span className="title">{c.category?.name ?? 'Без категории'}</span>
                  <small>
                    {c.count} {plural(c.count, 'трата', 'траты', 'трат')}
                  </small>
                </span>
                <b>{money(c.total)}</b>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="danger-zone">
        <button className="link danger" onClick={remove}>
          Удалить журнал
        </button>
      </div>
    </Sheet>
  );
}

// ---------- рассылка ----------

function Broadcast({ fail, done }: { fail: Fail; done: (text: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!(await confirmAction('Отправить это сообщение всем пользователям бота?'))) return;
    setBusy(true);
    await adminApi
      .broadcast(text)
      .then((r) => {
        setText('');
        done(`Отправляется ${r.recipients} ${plural(r.recipients, 'получателю', 'получателям', 'получателям')}`);
      })
      .catch(fail)
      .finally(() => setBusy(false));
  }

  return (
    <div className="card form spaced-top">
      <p className="muted">Сообщение придёт от бота всем, кто им пользовался, кроме заблокированных.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: «Добавили правку суммы — нажмите на трату»" rows={5} />
      <button className="primary" disabled={busy || !text.trim()} onClick={send}>
        Отправить всем
      </button>
    </div>
  );
}
