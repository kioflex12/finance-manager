import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  dayLabel,
  money,
  tg,
  type Category,
  type Me,
  type NewRoom,
  type Operation,
  type Overview,
  type Period,
  type RoomView,
} from './api';
import { Breakdown, CategoryBadge, categoryColor, Icon, Meter, OperationRow, share, Sheet, useBack } from './ui';

type Tab = 'home' | 'ops' | 'history' | 'room';
type Fail = (err: unknown) => void;

const ERRORS: Record<string, string> = {
  not_understood: 'Не нашёл сумму. Например: «400 продукты»',
  no_period: 'Срок комнаты закончился — начните новый период',
  unauthorized: 'Откройте приложение из Telegram',
};

const DAY_MS = 86_400_000;
const RECENT_COUNT = 5;

/** Экран из адреса (#ops, #history, #room) — для прямых ссылок на раздел; #add сразу открывает ввод траты. */
function initialTab(): Tab {
  const hash = location.hash.slice(1);
  return hash === 'ops' || hash === 'history' || hash === 'room' ? hash : 'home';
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  // undefined — текущий период, число — просмотр периода из истории
  const [periodId, setPeriodId] = useState<number | undefined>();
  const [view, setView] = useState<RoomView | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [tab, setTab] = useState<Tab>(initialTab);
  // undefined — экран категории закрыт; null — «без категории»
  const [category, setCategory] = useState<Category | null | undefined>();
  const [adding, setAdding] = useState(location.hash === '#add');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Operation | null>(null);
  const [error, setError] = useState('');

  const fail = useCallback<Fail>((err) => {
    const code = err instanceof ApiError ? err.code : '';
    setError(ERRORS[code] ?? 'Что-то пошло не так. Попробуйте ещё раз');
    tg?.HapticFeedback?.notificationOccurred('error');
  }, []);

  useEffect(() => {
    (async () => {
      // ссылка-приглашение или кнопка из группового чата открывают конкретную комнату
      const start = tg?.initDataUnsafe.start_param ?? '';
      let target: number | null = null;
      if (start.startsWith('join_')) target = (await api.join(start.slice(5)).catch(() => null))?.room.id ?? null;
      if (start.startsWith('room_')) target = Number(start.slice(5));
      const loaded = await api.me();
      setMe(loaded);
      setRoomId(loaded.rooms.some((r) => r.id === target) ? target : loaded.activeRoomId);
    })().catch(fail);
  }, [fail]);

  const reload = useCallback(async () => {
    if (!roomId) return;
    const next = await api.room(roomId, periodId);
    setView(next);
    setOperations(next.period ? (await api.operations(roomId, next.period.id)).operations : []);
  }, [roomId, periodId]);

  useEffect(() => {
    setView(null);
    reload().catch(fail);
  }, [reload, fail]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 3000);
    return () => clearTimeout(timer);
  }, [error]);

  const refresh = useCallback(() => void reload().catch(fail), [reload, fail]);

  async function openRoom(id: number) {
    setRoomId(id);
    setPeriodId(undefined);
    setCategory(undefined);
    setTab('home');
    await api.updateRoom(id, { active: true }).catch(fail);
  }

  if (!me || !view) {
    return <div className="splash">{error || <span className="spinner" />}</div>;
  }

  const { room, period } = view;
  const viewingHistory = periodId !== undefined;
  const colorOf = (c: Category | null) => categoryColor(c, view.categories);
  const shared = view.members.length > 1;

  return (
    <div className="app">
      {category !== undefined ? (
        <CategoryScreen
          category={category}
          operations={operations.filter((op) => (op.category?.id ?? null) === (category?.id ?? null))}
          color={colorOf(category)}
          shared={shared}
          onBack={() => setCategory(undefined)}
          onEdit={setEditing}
        />
      ) : (
        <>
          <header className="topbar">
            <button className="room-pill" onClick={() => setTab('room')}>
              <span className="avatar">{room.name.trim().charAt(0).toUpperCase()}</span>
              <span className="room-name">{room.name}</span>
              <Icon name="chevron" size={16} />
            </button>
            {shared && <span className="members">{view.members.length} участн.</span>}
          </header>

          {tab === 'home' && (
            <Home
              view={view}
              operations={operations}
              viewingHistory={viewingHistory}
              colorOf={colorOf}
              shared={shared}
              onOpenCategory={setCategory}
              onEdit={setEditing}
              onShowAll={() => setTab('ops')}
              onBackToCurrent={() => setPeriodId(undefined)}
              onSetBudget={() => setTab('room')}
              onStartPeriod={() => api.startPeriod(room.id).then(refresh).catch(fail)}
            />
          )}
          {tab === 'ops' && <Operations operations={operations} colorOf={colorOf} shared={shared} onEdit={setEditing} />}
          {tab === 'history' && (
            <History
              roomId={room.id}
              currentId={period?.id}
              onOpen={(p) => {
                setPeriodId(p.closedAt ? p.id : undefined);
                setTab('home');
              }}
              fail={fail}
            />
          )}
          {tab === 'room' && (
            <RoomTab me={me} view={view} onOpen={openRoom} onNew={() => setCreating(true)} onReload={refresh} fail={fail} />
          )}
        </>
      )}

      <nav className="tabbar">
        <TabButton icon="home" label="Обзор" active={tab === 'home' && category === undefined} onClick={() => (setCategory(undefined), setTab('home'))} />
        <TabButton icon="list" label="Траты" active={tab === 'ops' && category === undefined} onClick={() => (setCategory(undefined), setTab('ops'))} />
        <button className="fab" aria-label="Добавить трату" disabled={!period || viewingHistory} onClick={() => setAdding(true)}>
          <Icon name="plus" size={28} />
        </button>
        <TabButton icon="clock" label="История" active={tab === 'history' && category === undefined} onClick={() => (setCategory(undefined), setTab('history'))} />
        <TabButton icon="users" label="Комната" active={tab === 'room' && category === undefined} onClick={() => (setCategory(undefined), setTab('room'))} />
      </nav>

      {adding && (
        <AddSheet
          roomId={room.id}
          colorOf={colorOf}
          onClose={() => setAdding(false)}
          onAdded={(next, added) => {
            setView({ ...view, ...next });
            setOperations((list) => [...added, ...list]);
          }}
          onUndone={refresh}
          fail={fail}
        />
      )}
      {editing && (
        <EditSheet op={editing} categories={view.categories} onClose={() => setEditing(null)} onChanged={refresh} fail={fail} />
      )}
      {creating && (
        <NewRoomSheet
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const created = await api.createRoom(input);
            setMe({ ...me, rooms: [...me.rooms, created.room] });
            setCreating(false);
            await openRoom(created.room.id);
          }}
          fail={fail}
        />
      )}
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

function TabButton(props: { icon: 'home' | 'list' | 'clock' | 'users'; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={props.active ? 'tab active' : 'tab'} onClick={props.onClick}>
      <Icon name={props.icon} />
      <span>{props.label}</span>
    </button>
  );
}

function Home(props: {
  view: RoomView;
  operations: Operation[];
  viewingHistory: boolean;
  colorOf: (c: Category | null) => string;
  shared: boolean;
  onOpenCategory: (category: Category | null) => void;
  onEdit: (op: Operation) => void;
  onShowAll: () => void;
  onBackToCurrent: () => void;
  onSetBudget: () => void;
  onStartPeriod: () => void;
}) {
  const { view, operations, viewingHistory, colorOf } = props;
  const { period, stats, budget } = view;

  if (!period || !stats) {
    return (
      <main className="page">
        <div className="card empty-state">
          <div className="big-emoji">🏁</div>
          <h2>Срок комнаты закончился</h2>
          <p className="muted">Итоги сохранены в истории. Можно начать новый период.</p>
          <button className="primary" onClick={props.onStartPeriod}>
            Начать новый период
          </button>
        </div>
      </main>
    );
  }

  const end = Math.min(Date.now(), new Date(period.endsAt).getTime());
  const daysPassed = Math.max(1, Math.ceil((end - new Date(period.startsAt).getTime()) / DAY_MS));

  return (
    <main className="page">
      <section className="hero">
        <div className="hero-label">
          {viewingHistory ? 'Потрачено за период' : 'Потрачено'} · {period.label}
        </div>
        <div className="hero-amount">{money(stats.total)}</div>
        {budget ? (
          <>
            <Meter spent={stats.total} limit={budget.budget} />
            <div className="tiles">
              {budget.left >= 0 ? (
                <Tile label="Осталось" value={money(budget.left)} />
              ) : (
                <Tile label="Перерасход" value={money(-budget.left)} alert />
              )}
              <Tile label={budget.left >= 0 ? 'Можно в день' : 'Дней до конца'} value={budget.left >= 0 ? money(budget.perDay) : String(budget.daysLeft)} />
            </div>
          </>
        ) : (
          <div className="tiles">
            <Tile label="Трат" value={String(stats.count)} />
            <Tile label="В среднем в день" value={money(Math.round(stats.total / daysPassed / 100) * 100)} />
          </div>
        )}
        {viewingHistory ? (
          <button className="hero-link" onClick={props.onBackToCurrent}>
            ← К текущему периоду
          </button>
        ) : (
          !budget && (
            <button className="hero-link" onClick={props.onSetBudget}>
              Задать бюджет на период
            </button>
          )
        )}
      </section>

      {stats.count === 0 ? (
        <div className="card empty-state">
          <div className="big-emoji">🧾</div>
          <h2>Пока нет трат</h2>
          <p className="muted">Нажмите «+» и напишите, например, «400 продукты».</p>
        </div>
      ) : (
        <>
          <h3 className="section">Категории</h3>
          <div className="card">
            <Breakdown stats={stats} categories={view.categories} />
            <ul className="rows">
              {stats.byCategory.map(({ category, total, count }) => (
                <li key={category?.id ?? 0} onClick={() => props.onOpenCategory(category)}>
                  <CategoryBadge category={category} color={colorOf(category)} />
                  <span className="grow">
                    <span className="title">{category?.name ?? 'Без категории'}</span>
                    <small>
                      {count} {plural(count, 'трата', 'траты', 'трат')} · {share(total, stats.total)}
                    </small>
                  </span>
                  <b>{money(total)}</b>
                  <span className="chev">
                    <Icon name="right" size={16} />
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="section-row">
            <h3 className="section">Последние траты</h3>
            {operations.length > RECENT_COUNT && (
              <button className="link" onClick={props.onShowAll}>
                Все
              </button>
            )}
          </div>
          <ul className="card rows">
            {operations.slice(0, RECENT_COUNT).map((op) => (
              <OperationRow key={op.id} op={op} color={colorOf(op.category)} showUser={props.shared} onClick={() => props.onEdit(op)} />
            ))}
          </ul>

          {stats.byMember.length > 1 && (
            <>
              <h3 className="section">Участники</h3>
              <ul className="card rows">
                {stats.byMember.map((m) => (
                  <li key={m.userId} className="static">
                    <span className="avatar small">{m.name.charAt(0).toUpperCase()}</span>
                    <span className="grow">
                      <span className="title">{m.name}</span>
                      <small>{share(m.total, stats.total)}</small>
                    </span>
                    <b>{money(m.total)}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </main>
  );
}

function Tile({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={alert ? 'tile alert' : 'tile'}>
      <span>
        {alert && <Icon name="alert" size={14} />} {label}
      </span>
      <b>{value}</b>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Лента трат, сгруппированная по дням, с суммой за день. */
function DayGroups(props: { operations: Operation[]; colorOf: (c: Category | null) => string; shared: boolean; onEdit: (op: Operation) => void }) {
  const groups: { label: string; items: Operation[] }[] = [];
  for (const op of props.operations) {
    const label = dayLabel(op.createdAt);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(op);
    else groups.push({ label, items: [op] });
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.label}>
          <div className="section-row">
            <h3 className="section">{group.label}</h3>
            <span className="muted">{money(group.items.reduce((sum, op) => sum + op.amount, 0))}</span>
          </div>
          <ul className="card rows">
            {group.items.map((op) => (
              <OperationRow key={op.id} op={op} color={props.colorOf(op.category)} showUser={props.shared} onClick={() => props.onEdit(op)} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function Operations(props: { operations: Operation[]; colorOf: (c: Category | null) => string; shared: boolean; onEdit: (op: Operation) => void }) {
  return (
    <main className="page">
      <h1>Траты</h1>
      {props.operations.length ? (
        <DayGroups {...props} />
      ) : (
        <div className="card empty-state">
          <div className="big-emoji">🧾</div>
          <p className="muted">В этом периоде трат пока нет.</p>
        </div>
      )}
    </main>
  );
}

function CategoryScreen(props: {
  category: Category | null;
  operations: Operation[];
  color: string;
  shared: boolean;
  onBack: () => void;
  onEdit: (op: Operation) => void;
}) {
  const { category, operations } = props;
  useBack(props.onBack);
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-button" aria-label="Назад" onClick={props.onBack}>
          <Icon name="back" />
        </button>
      </header>
      <div className="category-head">
        <CategoryBadge category={category} color={props.color} />
        <div>
          <h1>{category?.name ?? 'Без категории'}</h1>
          <span className="muted">
            {money(operations.reduce((sum, op) => sum + op.amount, 0))} · {operations.length}{' '}
            {plural(operations.length, 'трата', 'траты', 'трат')}
          </span>
        </div>
      </div>
      {operations.length ? (
        <DayGroups operations={operations} colorOf={() => props.color} shared={props.shared} onEdit={props.onEdit} />
      ) : (
        <div className="card empty-state">
          <p className="muted">Здесь больше ничего нет.</p>
        </div>
      )}
    </main>
  );
}

function History(props: { roomId: number; currentId: number | undefined; onOpen: (period: Period) => void; fail: Fail }) {
  const { roomId, fail } = props;
  const [periods, setPeriods] = useState<Period[] | null>(null);
  useEffect(() => {
    api
      .periods(roomId)
      .then((r) => setPeriods(r.periods))
      .catch(fail);
  }, [roomId, fail]);

  const max = Math.max(1, ...(periods ?? []).map((p) => p.total ?? 0));

  return (
    <main className="page">
      <h1>История</h1>
      <ul className="card rows">
        {periods?.map((p) => (
          <li key={p.id} className="period" onClick={() => props.onOpen(p)}>
            <span className="grow">
              <span className="title">{p.label}</span>
              <small>{p.closedAt ? 'завершён' : 'идёт сейчас'}</small>
              <span className="bar">
                <span className={p.closedAt ? '' : 'current'} style={{ width: `${((p.total ?? 0) / max) * 100}%` }} />
              </span>
            </span>
            <b>{money(p.total ?? 0)}</b>
          </li>
        ))}
      </ul>
      {periods?.length === 1 && <p className="muted hint">Здесь будут итоги прошлых периодов — их можно открыть и сравнить.</p>}
    </main>
  );
}

function RoomTab(props: { me: Me; view: RoomView; onOpen: (id: number) => void; onNew: () => void; onReload: () => void; fail: Fail }) {
  const { me, view, fail } = props;
  const { room } = view;
  const [budget, setBudget] = useState(room.budget ? String(room.budget / 100) : '');
  const invite = me.botUsername ? `https://t.me/${me.botUsername}?start=join_${room.inviteCode}` : '';

  const save = (patch: { budget?: number | null; autoRenew?: boolean }) =>
    api.updateRoom(room.id, patch).then(props.onReload).catch(fail);

  return (
    <main className="page">
      <h1>Комнаты</h1>
      <ul className="card rows">
        {me.rooms.map((r) => (
          <li key={r.id} onClick={() => props.onOpen(r.id)}>
            <span className="avatar small">{r.name.trim().charAt(0).toUpperCase()}</span>
            <span className="grow">
              <span className="title">{r.name}</span>
              <small>{r.periodKind === 'month' ? 'ежемесячная' : `на ${r.periodDays} дн.`}</small>
            </span>
            {r.id === room.id && (
              <span className="current-mark">
                <Icon name="check" size={18} />
              </span>
            )}
          </li>
        ))}
        <li onClick={props.onNew}>
          <span className="avatar small ghost">
            <Icon name="plus" size={18} />
          </span>
          <span className="grow">
            <span className="title accent">Новая комната</span>
          </span>
        </li>
      </ul>

      <h3 className="section">Настройки · {room.name}</h3>
      <div className="card form">
        <label>
          Бюджет на период, ₽
          <input
            inputMode="numeric"
            value={budget}
            placeholder="без бюджета"
            onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))}
            onBlur={() => save({ budget: budget ? Number(budget) * 100 : null })}
          />
        </label>
        <label className="switch-row">
          <span>Автоматически начинать новый период</span>
          <input type="checkbox" className="switch" checked={room.autoRenew} onChange={(e) => save({ autoRenew: e.target.checked })} />
        </label>
      </div>

      <h3 className="section">Участники</h3>
      <div className="card form">
        <div className="people">
          {view.members.map((m) => (
            <span key={m.id} className="person">
              <span className="avatar small">{m.name.charAt(0).toUpperCase()}</span>
              {m.name}
            </span>
          ))}
        </div>
        {invite && (
          <button
            className="primary"
            onClick={() =>
              tg?.openTelegramLink(
                `https://t.me/share/url?url=${encodeURIComponent(invite)}&text=${encodeURIComponent(`Давай вести траты вместе: «${room.name}»`)}`,
              )
            }
          >
            Пригласить в комнату
          </button>
        )}
      </div>
    </main>
  );
}

const EXAMPLES = ['400 продукты', 'такси 650', 'кофе 280 и обед 450'];

function AddSheet(props: {
  roomId: number;
  colorOf: (c: Category | null) => string;
  onClose: () => void;
  onAdded: (next: Overview, added: Operation[]) => void;
  onUndone: () => void;
  fail: Fail;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Operation[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const { operations, ...next } = await api.add(props.roomId, text);
      setAdded(operations);
      setText('');
      props.onAdded(next, operations);
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (err) {
      props.fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    await Promise.all(added.map((op) => api.remove(op.id))).catch(props.fail);
    setAdded([]);
    props.onUndone();
  }

  return (
    <Sheet title="Новая трата" onClose={props.onClose}>
      <form className="add-form" onSubmit={submit}>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Сумма и на что" enterKeyHint="send" />
        <button className="primary square" disabled={busy || !text.trim()} aria-label="Записать">
          {busy ? <span className="spinner light" /> : <Icon name="check" />}
        </button>
      </form>
      {added.length > 0 ? (
        <div className="added">
          <ul className="rows">
            {added.map((op) => (
              <li key={op.id} className="static">
                <CategoryBadge category={op.category} color={props.colorOf(op.category)} />
                <span className="grow">
                  <span className="title">{op.description}</span>
                  <small>{op.category?.name}</small>
                </span>
                <b>{money(op.amount)}</b>
              </li>
            ))}
          </ul>
          <div className="added-actions">
            <span className="muted">Записано. Можно вводить следующую.</span>
            <button className="link danger" onClick={undo}>
              Отменить
            </button>
          </div>
        </div>
      ) : (
        <div className="chips">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="chip" onClick={() => setText(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function EditSheet(props: { op: Operation; categories: Category[]; onClose: () => void; onChanged: () => void; fail: Fail }) {
  const { op } = props;
  const act = (action: Promise<unknown>) => action.then(props.onChanged).catch(props.fail).finally(props.onClose);

  return (
    <Sheet title={op.description} onClose={props.onClose}>
      <div className="edit-amount">{money(op.amount)}</div>
      <p className="muted">Куда отнести? Запомню для таких же трат.</p>
      <div className="chips">
        {props.categories.map((c) => (
          <button
            key={c.id}
            className={c.id === op.category?.id ? 'chip active' : 'chip'}
            onClick={() => act(api.setCategory(op.id, c.id))}
          >
            {c.emoji} {c.name}
          </button>
        ))}
      </div>
      <button className="link danger block" onClick={() => act(api.remove(op.id))}>
        Удалить трату
      </button>
    </Sheet>
  );
}

function NewRoomSheet(props: { onClose: () => void; onCreate: (room: NewRoom) => Promise<void>; fail: Fail }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'month' | 'days'>('month');
  const [days, setDays] = useState('10');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await props
      .onCreate({
        name,
        periodKind: kind,
        periodDays: Number(days) || 10,
        // ежемесячная продлевается сама, комната на срок закрывается с итогами
        autoRenew: kind === 'month',
        budget: budget ? Number(budget) * 100 : null,
      })
      .catch(props.fail);
    setBusy(false);
  }

  return (
    <Sheet title="Новая комната" onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Название
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Отпуск в Сочи" maxLength={64} />
        </label>
        <div className="segmented">
          <button type="button" className={kind === 'month' ? 'active' : ''} onClick={() => setKind('month')}>
            Ежемесячная
          </button>
          <button type="button" className={kind === 'days' ? 'active' : ''} onClick={() => setKind('days')}>
            На срок
          </button>
        </div>
        {kind === 'days' && (
          <label>
            Сколько дней
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        <label>
          Бюджет на период, ₽
          <input inputMode="numeric" value={budget} placeholder="необязательно" onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button className="primary" disabled={busy || !name.trim()}>
          Создать комнату
        </button>
      </form>
    </Sheet>
  );
}
