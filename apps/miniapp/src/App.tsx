import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  confirmAction,
  dayLabel,
  money,
  tg,
  type Category,
  type Me,
  type NewRoom,
  type Operation,
  type Overview,
  type Period,
  type Room,
  type RoomColor,
  type RoomView,
  type Stats,
  roomEventsUrl,
} from './api';
import {
  Breakdown,
  CategoryBadge,
  categoryColor,
  Icon,
  Meter,
  OperationRow,
  ROOM_COLORS,
  RoomAvatar,
  roomVars,
  share,
  Sheet,
  useBack,
} from './ui';

type Tab = 'home' | 'ops' | 'room';
type Fail = (err: unknown) => void;
type ColorOf = (c: Category | null) => string;

const ERRORS: Record<string, string> = {
  not_understood: 'Не нашёл сумму. Например: «400 продукты»',
  no_period: 'Срок журнала закончился — начните новый период',
  unauthorized: 'Откройте приложение из Telegram',
  forbidden: 'Это может сделать только владелец журнала',
};

const DAY_MS = 86_400_000;
const RECENT_COUNT = 5;

/** Версия с сервера (из события ready) отличается от версии этой сборки. В режиме разработки версии нет. */
function isNewVersion(data: string): boolean {
  try {
    const { version } = JSON.parse(data) as { version?: string };
    return Boolean(version) && version !== __BUILD_ID__;
  } catch {
    return false;
  }
}

/** Экран из адреса (#ops, #room) — для прямых ссылок на раздел; #add сразу открывает ввод траты. */
function initialTab(): Tab {
  const hash = location.hash.slice(1);
  if (hash === 'ops' || hash === 'history') return 'ops';
  return hash === 'room' ? 'room' : 'home';
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
  // фильтр ленты трат по участнику общей комнаты
  // фильтр общего журнала по участнику (id пользователя); действует на все вкладки, пока его не сняли
  const [memberFilter, setMemberFilter] = useState<number | null>(null);
  const [adding, setAdding] = useState(location.hash === '#add');
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [choosingPeriod, setChoosingPeriod] = useState(false);
  const [editing, setEditing] = useState<Operation | null>(null);
  // на сервере новая версия, а перезагрузиться сейчас нельзя — открыт ввод
  const [updateReady, setUpdateReady] = useState(false);
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

  // новая версия: перезагружаемся сами, если пользователь ничего не вводит; иначе показываем плашку
  const busy = adding || creating || configuring || editing !== null;
  useEffect(() => {
    if (updateReady && !busy) location.reload();
  }, [updateReady, busy]);

  // Живые обновления: бот, другое устройство или участник журнала что-то записали — перечитываем.
  // Тихо, без ошибок на экране: обновление фоновое.
  useEffect(() => {
    // автоматизированный браузер (скриншоты, проверки) ждёт тишины в сети — открытый поток ему мешает
    if (!roomId || navigator.webdriver) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // запись и подбор категории приходят парой событий подряд — перечитываем один раз
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload().catch(() => {}), 300);
    };
    const events = new EventSource(roomEventsUrl(roomId));
    let opened = false;
    events.addEventListener('change', soon);
    // после обрыва EventSource переподключается сам; пропущенное за это время подтягиваем разом
    events.addEventListener('ready', (e) => {
      if (isNewVersion(e.data)) setUpdateReady(true);
      if (opened) soon();
      opened = true;
    });
    // вернулся в приложение из чата — данные могли устареть, пока оно было свёрнуто
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      soon();
      // соединение могло не переподключиться, пока приложение было свёрнуто — спрашиваем версию напрямую
      fetch('/version.json', { cache: 'no-store' })
        .then((r) => r.json())
        .then((v: { version?: string }) => v.version && v.version !== __BUILD_ID__ && setUpdateReady(true))
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      events.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [roomId, reload]);

  /** Переход на вкладку нижней панели: всегда с самого начала — без вложенного экрана и прокрутки. Фильтр по человеку остаётся. */
  function go(next: Tab) {
    tg?.HapticFeedback?.selectionChanged();
    setCategory(undefined);
    setTab(next);
    window.scrollTo({ top: 0 });
  }

  async function openRoom(id: number) {
    setRoomId(id);
    setPeriodId(undefined);
    setMemberFilter(null);
    go('home');
    await api.updateRoom(id, { active: true }).catch(fail);
  }

  if (!me || !view) {
    return <div className="splash">{error || <span className="spinner" />}</div>;
  }

  const { room, period } = view;
  const viewingHistory = periodId !== undefined;
  const colorOf: ColorOf = (c) => categoryColor(c, view.categories);
  const shared = view.members.length > 1;
  const onMain = category === undefined;
  // выбранный человек мог выйти из журнала — тогда фильтр не действует
  const member = shared ? view.members.find((m) => m.id === memberFilter) : undefined;
  const visibleOps = member ? operations.filter((op) => op.userId === member.id) : operations;
  // при фильтре суммы считаются по тратам человека; бюджет — общий на журнал, поэтому его не показываем
  const visibleView: RoomView = member && view.stats ? { ...view, stats: { ...statsOf(visibleOps), byMember: view.stats.byMember }, budget: null } : view;
  const toggleMember = (id: number) => {
    tg?.HapticFeedback?.selectionChanged();
    setMemberFilter(memberFilter === id ? null : id);
  };

  return (
    <div className="app" style={roomVars(room.color)}>
      {category !== undefined ? (
        <CategoryScreen
          category={category}
          operations={visibleOps.filter((op) => (op.category?.id ?? null) === (category?.id ?? null))}
          memberName={member?.name}
          color={colorOf(category)}
          shared={shared}
          onBack={() => setCategory(undefined)}
          onEdit={setEditing}
        />
      ) : (
        <>
          <header className="topbar">
            <button className="room-pill" onClick={() => go('room')}>
              <RoomAvatar room={room} size="pill" />
              <span className="room-name">{room.name}</span>
              <Icon name="chevron" size={16} />
            </button>
            {shared && (
              <button className="members" onClick={() => go('room')}>
                {view.members.length} участн.
              </button>
            )}
          </header>

          {shared && tab !== 'room' && (
            <div className="member-filter">
              <div className="chips">
                <button className={member ? 'chip' : 'chip active'} onClick={() => setMemberFilter(null)}>
                  Все
                </button>
                {view.members.map((m) => (
                  <button key={m.id} className={member?.id === m.id ? 'chip active' : 'chip'} onClick={() => toggleMember(m.id)}>
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {tab === 'home' && (
            <Home
              view={visibleView}
              memberName={member?.name}
              memberFilter={member?.id ?? null}
              onMember={toggleMember}
              operations={visibleOps}
              viewingHistory={viewingHistory}
              colorOf={colorOf}
              shared={shared}
              onOpenCategory={(c) => {
                setCategory(c);
                // экран категории открывается с начала, а не с прокрутки обзора
                window.scrollTo({ top: 0 });
              }}
              onEdit={setEditing}
              onShowAll={() => go('ops')}
              onChoosePeriod={() => setChoosingPeriod(true)}
              onBackToCurrent={() => setPeriodId(undefined)}
              onSetBudget={() => setConfiguring(true)}
              onAdd={() => setAdding(true)}
              onStartPeriod={() => api.startPeriod(room.id).then(refresh).catch(fail)}
            />
          )}
          {tab === 'ops' && (
            <Operations
              periodLabel={period?.label ?? ''}
              viewingHistory={viewingHistory}
              onChoosePeriod={() => setChoosingPeriod(true)}
              onBackToCurrent={() => setPeriodId(undefined)}
              operations={visibleOps}
              colorOf={colorOf}
              shared={shared}
              onEdit={setEditing}
            />
          )}
          {tab === 'room' && (
            <RoomTab
              me={me}
              view={view}
              onOpen={openRoom}
              onNew={() => setCreating(true)}
              onConfigure={() => setConfiguring(true)}
              onChoosePeriod={() => setChoosingPeriod(true)}
            />
          )}
        </>
      )}

      <button className="fab" aria-label="Добавить трату" disabled={!period || viewingHistory} onClick={() => setAdding(true)}>
        <Icon name="plus" size={28} />
      </button>
      <nav className="tabbar">
        <TabButton icon="home" label="Обзор" active={tab === 'home' && onMain} onClick={() => go('home')} />
        <TabButton icon="list" label="История" active={tab === 'ops' && onMain} onClick={() => go('ops')} />
        <TabButton icon="users" label="Журнал" active={tab === 'room' && onMain} onClick={() => go('room')} />
      </nav>

      {choosingPeriod && (
        <PeriodsSheet
          roomId={room.id}
          currentId={periodId ?? period?.id}
          onClose={() => setChoosingPeriod(false)}
          onOpen={(p) => {
            setPeriodId(p.closedAt ? p.id : undefined);
            setChoosingPeriod(false);
          }}
          fail={fail}
        />
      )}

      {adding && (
        <AddSheet
          roomId={room.id}
          colorOf={colorOf}
          onClose={() => setAdding(false)}
          onAdded={(next, added) => {
            setView({ ...view, ...next });
            setOperations((list) => [...added, ...list]);
          }}
          onEdit={setEditing}
          onUndone={refresh}
          fail={fail}
        />
      )}
      {configuring && (
        <RoomSettingsSheet
          room={room}
          isOwner={room.ownerId === me.user.id}
          onClose={() => setConfiguring(false)}
          onSaved={(updated) => {
            setMe({ ...me, rooms: me.rooms.map((r) => (r.id === updated.id ? updated : r)) });
            refresh();
          }}
          onCleared={refresh}
          onRemoved={(next) => {
            setMe({ ...me, ...next });
            setConfiguring(false);
            setPeriodId(undefined);
            setRoomId(next.activeRoomId);
            go('home');
          }}
          fail={fail}
        />
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
      {editing && (
        <EditSheet op={editing} categories={view.categories} onClose={() => setEditing(null)} onChanged={refresh} fail={fail} />
      )}
      {error && <div className="toast">{error}</div>}
      {updateReady && busy && (
        <button className="update-banner" onClick={() => location.reload()}>
          Вышло обновление · обновить
        </button>
      )}
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
  colorOf: ColorOf;
  shared: boolean;
  onOpenCategory: (category: Category | null) => void;
  onEdit: (op: Operation) => void;
  onShowAll: () => void;
  /** имя выбранного в фильтре человека: суммы на экране — только его */
  memberName?: string;
  memberFilter: number | null;
  onMember: (userId: number) => void;
  onChoosePeriod: () => void;
  onBackToCurrent: () => void;
  onSetBudget: () => void;
  onAdd: () => void;
  onStartPeriod: () => void;
}) {
  const { view, operations, viewingHistory, colorOf } = props;
  const { period, stats, budget } = view;

  if (!period || !stats) {
    return (
      <main className="page">
        <div className="card empty-state">
          <div className="big-emoji">🏁</div>
          <h2>Срок журнала закончился</h2>
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
        <button className="hero-period" onClick={props.onChoosePeriod}>
          {period.label} <Icon name="chevron" size={14} />
        </button>
        <button className="hero-total" onClick={() => props.onShowAll()}>
          <span className="hero-label">
            {viewingHistory ? 'Потрачено за период' : 'Потрачено'}
            {props.memberName && ` · ${props.memberName}`}
          </span>
          <span className="hero-amount">{money(stats.total)}</span>
        </button>
        {budget ? (
          <>
            <Meter spent={stats.total} limit={budget.budget} />
            <div className="tiles">
              {budget.left >= 0 ? (
                <Tile label="Осталось" value={money(budget.left)} onClick={props.onSetBudget} />
              ) : (
                <Tile label="Перерасход" value={money(-budget.left)} alert onClick={props.onSetBudget} />
              )}
              <Tile
                label={budget.left >= 0 ? 'Можно в день' : 'Дней до конца'}
                value={budget.left >= 0 ? money(budget.perDay) : String(budget.daysLeft)}
                onClick={props.onSetBudget}
              />
            </div>
          </>
        ) : (
          <div className="tiles">
            <Tile label="Трат" value={String(stats.count)} onClick={() => props.onShowAll()} />
            <Tile label="В среднем в день" value={money(Math.round(stats.total / daysPassed / 100) * 100)} onClick={() => props.onShowAll()} />
          </div>
        )}
        {viewingHistory ? (
          <button className="hero-link" onClick={props.onBackToCurrent}>
            ← К текущему периоду
          </button>
        ) : (
          !budget &&
          !props.memberName && (
            <button className="hero-link" onClick={props.onSetBudget}>
              Задать бюджет на период
            </button>
          )
        )}
      </section>

      {stats.count === 0 && props.memberName ? (
        <div className="card empty-state">
          <div className="big-emoji">🧾</div>
          <p className="muted">У {props.memberName} в этом периоде трат нет.</p>
        </div>
      ) : stats.count === 0 ? (
        <button className="card empty-state pressable" disabled={viewingHistory} onClick={props.onAdd}>
          <div className="big-emoji">🧾</div>
          <h2>Пока нет трат</h2>
          <p className="muted">Нажмите сюда или на «+» и напишите, например, «400 продукты».</p>
        </button>
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
            <button className="link" onClick={() => props.onShowAll()}>
              Все
            </button>
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
                  <li key={m.userId} className={props.memberFilter === m.userId ? 'picked' : ''} onClick={() => props.onMember(m.userId)}>
                    <span className="avatar small">{m.name.charAt(0).toUpperCase()}</span>
                    <span className="grow">
                      <span className="title">{m.name}</span>
                      <small>
                        {share(m.total, stats.byMember.reduce((all, x) => all + x.total, 0))}
                        {props.memberFilter === m.userId ? ' · показаны только его траты' : ' · нажмите, чтобы показать только его траты'}
                      </small>
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

function Tile({ label, value, alert, onClick }: { label: string; value: string; alert?: boolean; onClick: () => void }) {
  return (
    <button className={alert ? 'tile alert' : 'tile'} onClick={onClick}>
      <span>
        {alert && <Icon name="alert" size={14} />} {label}
      </span>
      <b>{value}</b>
    </button>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const sum = (operations: Operation[]) => operations.reduce((total, op) => total + op.amount, 0);

/** Итоги по набору трат — для фильтра по человеку, когда считать нужно только его траты. */
function statsOf(operations: Operation[]): Stats {
  const byCategory = new Map<number, Stats['byCategory'][number]>();
  const byMember = new Map<number, Stats['byMember'][number]>();
  for (const op of operations) {
    const key = op.category?.id ?? 0;
    const row = byCategory.get(key) ?? { category: op.category, total: 0, count: 0 };
    row.total += op.amount;
    row.count += 1;
    byCategory.set(key, row);
    const person = byMember.get(op.userId) ?? { userId: op.userId, name: op.userName, total: 0 };
    person.total += op.amount;
    byMember.set(op.userId, person);
  }
  return {
    total: sum(operations),
    count: operations.length,
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    byMember: [...byMember.values()].sort((a, b) => b.total - a.total),
  };
}

/** Исходные слова совпадают с названием траты — показывать их отдельно незачем. */
const sameWords = (op: Operation) => op.description.toLowerCase().replace(/ё/g, 'е') === op.item.toLowerCase().replace(/ё/g, 'е');

/** Лента трат, сгруппированная по дням, с суммой за день. */
function DayGroups(props: { operations: Operation[]; colorOf: ColorOf; shared: boolean; onEdit: (op: Operation) => void }) {
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
            <span className="muted">{money(sum(group.items))}</span>
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

function Operations(props: {
  periodLabel: string;
  viewingHistory: boolean;
  onChoosePeriod: () => void;
  onBackToCurrent: () => void;
  operations: Operation[];
  colorOf: ColorOf;
  shared: boolean;
  onEdit: (op: Operation) => void;
}) {
  const { operations } = props;
  return (
    <main className="page">
      <div className="title-row">
        <h1>История</h1>
        <button className="period-chip" onClick={props.onChoosePeriod}>
          {props.periodLabel} <Icon name="chevron" size={14} />
        </button>
      </div>
      {props.viewingHistory && (
        <button className="past-banner" onClick={props.onBackToCurrent}>
          Прошлый период · вернуться к текущему
        </button>
      )}
      {operations.length ? (
        <DayGroups operations={operations} colorOf={props.colorOf} shared={props.shared} onEdit={props.onEdit} />
      ) : (
        <div className="card empty-state">
          <div className="big-emoji">🧾</div>
          <p className="muted">В этом периоде трат пока нет.</p>
        </div>
      )}
    </main>
  );
}

/** Категория изнутри: траты сложены по позициям («кофе» — 2 траты — 800 ₽), позиция раскрывается в список. */
function CategoryScreen(props: {
  category: Category | null;
  operations: Operation[];
  memberName?: string;
  color: string;
  shared: boolean;
  onBack: () => void;
  onEdit: (op: Operation) => void;
}) {
  const { category, operations } = props;
  // позиции раскрываются независимо: открытие одной не сворачивает другие
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  useBack(props.onBack);

  const byItem = new Map<string, Operation[]>();
  // группируем без учёта регистра: старые записи и новые могли получить «кофе» и «Кофе»
  for (const op of operations) {
    const key = op.item.toLowerCase();
    byItem.set(key, [...(byItem.get(key) ?? []), op]);
  }
  const items = [...byItem.values()]
    .map((list) => ({ name: list[0]!.item, list, total: sum(list) }))
    .sort((a, b) => b.total - a.total);
  const total = sum(operations);

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
            {money(total)} · {operations.length} {plural(operations.length, 'трата', 'траты', 'трат')}
            {props.memberName && ` · ${props.memberName}`}
          </span>
        </div>
      </div>

      {items.length === 0 && (
        <div className="card empty-state">
          <p className="muted">Здесь больше ничего нет.</p>
        </div>
      )}
      {items.map((item) => (
        <div key={item.name} className="card item">
          <button
            className="item-head"
            aria-expanded={open.has(item.name)}
            onClick={() => {
              tg?.HapticFeedback?.selectionChanged();
              toggle(item.name);
            }}
          >
            <span className="grow">
              <span className="title">{item.name}</span>
              <small>
                {item.list.length} {plural(item.list.length, 'трата', 'траты', 'трат')} · {share(item.total, total)}
              </small>
              <span className="bar">
                <span style={{ width: `${(item.total / (items[0]?.total || 1)) * 100}%`, background: props.color }} />
              </span>
            </span>
            <b>{money(item.total)}</b>
            <span className={open.has(item.name) ? 'chev open' : 'chev'}>
              <Icon name="chevron" size={18} />
            </span>
          </button>
          {open.has(item.name) && (
            <ul className="rows nested">
              {item.list.map((op) => (
                <li key={op.id} onClick={() => props.onEdit(op)}>
                  <span className="grow">
                    <span className="title">
                      {dayLabel(op.createdAt)}, {new Date(op.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <small>
                      {sameWords(op) ? item.name : `«${op.description}»`}
                      {props.shared && ` · ${op.userName}`}
                    </small>
                  </span>
                  <b>{money(op.amount)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </main>
  );
}

/** Выбор периода: идущий и прошлые с итогами; полоска — сумма относительно самого дорогого периода. */
function PeriodsSheet(props: {
  roomId: number;
  currentId: number | undefined;
  onClose: () => void;
  onOpen: (period: Period) => void;
  fail: Fail;
}) {
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
    <Sheet title="Периоды" onClose={props.onClose}>
      <ul className="rows">
        {periods?.map((p) => (
          <li key={p.id} onClick={() => props.onOpen(p)}>
            <span className="grow">
              <span className="title">{p.label}</span>
              <small>{p.closedAt ? 'завершён' : 'идёт сейчас'}</small>
              <span className="bar">
                <span className={p.closedAt ? '' : 'current'} style={{ width: `${((p.total ?? 0) / max) * 100}%` }} />
              </span>
            </span>
            <b>{money(p.total ?? 0)}</b>
            {p.id === props.currentId && (
              <span className="current-mark">
                <Icon name="check" size={18} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {periods?.length === 1 && (
        <p className="muted hint">Когда период закончится, его итоги останутся здесь — их можно будет открыть и сравнить.</p>
      )}
    </Sheet>
  );
}

function periodText(room: Room): string {
  return room.periodKind === 'month' ? 'ежемесячный' : `на ${room.periodDays} дн.`;
}

function RoomTab(props: {
  me: Me;
  view: RoomView;
  onOpen: (id: number) => void;
  onNew: () => void;
  onConfigure: () => void;
  onChoosePeriod: () => void;
}) {
  const { me, view } = props;
  const { room } = view;
  const invite = me.botUsername ? `https://t.me/${me.botUsername}?start=join_${room.inviteCode}` : '';

  return (
    <main className="page">
      <h1>Журнал</h1>
      <button className="card room-card pressable" onClick={props.onConfigure}>
        <RoomAvatar room={room} size="large" />
        <span className="grow">
          <span className="title">{room.name}</span>
          <small>
            {periodText(room)} · {room.budget ? `бюджет ${money(room.budget)}` : 'без бюджета'}
          </small>
        </span>
        <span className="pill-action">Настроить</span>
      </button>

      <ul className="card rows spaced">
        <li onClick={props.onChoosePeriod}>
          <span className="avatar small ghost">
            <Icon name="clock" size={18} />
          </span>
          <span className="grow">
            <span className="title">Периоды и итоги</span>
            <small>{view.period?.label ?? 'текущий период закончился'}</small>
          </span>
          <span className="chev">
            <Icon name="right" size={16} />
          </span>
        </li>
      </ul>

      <h3 className="section">Участники</h3>
      <div className="card form">
        <div className="people">
          {view.members.map((m) => (
            <span key={m.id} className="person">
              <span className="avatar small">{m.name.charAt(0).toUpperCase()}</span>
              {m.name}
              {m.id === room.ownerId && <small className="muted">владелец</small>}
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
            Пригласить в журнал
          </button>
        )}
      </div>

      <h3 className="section">Все журналы</h3>
      <ul className="card rows">
        {me.rooms.map((r) => (
          <li key={r.id} onClick={() => props.onOpen(r.id)}>
            <RoomAvatar room={r.id === room.id ? room : r} />
            <span className="grow">
              <span className="title">{r.id === room.id ? room.name : r.name}</span>
              <small>{periodText(r.id === room.id ? room : r)}</small>
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
            <span className="title accent">Новый журнал</span>
          </span>
        </li>
      </ul>
    </main>
  );
}

const ROOM_EMOJI = ['🏠', '👨‍👩‍👧', '👩‍❤️‍👨', '✈️', '🏖', '🚗', '🎉', '🛒', '🐶', '🎓', '💼', '🏗', '🎁', '🍽', '💊', '⚽', '🎮', '💰'];

function RoomSettingsSheet(props: {
  room: Room;
  isOwner: boolean;
  onClose: () => void;
  onSaved: (room: Room) => void;
  onCleared: () => void;
  onRemoved: (next: { activeRoomId: number; rooms: Room[] }) => void;
  fail: Fail;
}) {
  const { room, fail } = props;
  const [name, setName] = useState(room.name);
  const [emoji, setEmoji] = useState(room.emoji);
  const [color, setColor] = useState<RoomColor>(room.color);
  const [kind, setKind] = useState(room.periodKind);
  const [days, setDays] = useState(String(room.periodDays));
  const [budget, setBudget] = useState(room.budget ? String(room.budget / 100) : '');
  const [autoRenew, setAutoRenew] = useState(room.autoRenew);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api.updateRoom(room.id, {
        name,
        emoji,
        color,
        periodKind: kind,
        periodDays: Number(days) || room.periodDays,
        budget: budget ? Number(budget) * 100 : null,
        autoRenew,
      });
      tg?.HapticFeedback?.notificationOccurred('success');
      props.onSaved(updated.room);
      props.onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!(await confirmAction('Удалить все траты текущего периода? Отменить это нельзя.'))) return;
    await api.clearOperations(room.id).then(props.onCleared).then(props.onClose).catch(fail);
  }

  async function remove() {
    const question = props.isOwner
      ? `Удалить журнал «${room.name}» со всеми тратами и историей? Отменить это нельзя.`
      : `Выйти из журнала «${room.name}»?`;
    if (!(await confirmAction(question))) return;
    await api.deleteRoom(room.id).then(props.onRemoved).catch(fail);
  }

  const periodChanged = kind !== room.periodKind || (kind === 'days' && Number(days) !== room.periodDays);

  return (
    <Sheet title="Настройки журнала" onClose={props.onClose}>
      <form className="form" onSubmit={save} style={roomVars(color)}>
        <div className="look">
          <RoomAvatar room={{ name: name || room.name, emoji, color }} size="large" />
          <label className="grow">
            Название
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </label>
        </div>

        <div>
          <div className="field-label">Аватар</div>
          <div className="emoji-grid">
            <button type="button" className={emoji === null ? 'active' : ''} onClick={() => setEmoji(null)}>
              {(name || room.name).trim().charAt(0).toUpperCase()}
            </button>
            {ROOM_EMOJI.map((value) => (
              <button type="button" key={value} className={emoji === value ? 'active' : ''} onClick={() => setEmoji(value)}>
                {value}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="field-label">Цвет</div>
          <div className="swatches">
            {(Object.keys(ROOM_COLORS) as RoomColor[]).map((value) => (
              <button
                type="button"
                key={value}
                aria-label={value}
                className={color === value ? 'active' : ''}
                style={roomVars(value)}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="field-label">Период</div>
          <div className="segmented">
            <button type="button" className={kind === 'month' ? 'active' : ''} onClick={() => setKind('month')}>
              Месяц
            </button>
            <button type="button" className={kind === 'days' ? 'active' : ''} onClick={() => setKind('days')}>
              Срок в днях
            </button>
          </div>
        </div>
        {kind === 'days' && (
          <label>
            Сколько дней
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        {periodChanged && <p className="muted">Текущий период дойдёт до конца, новая длина начнёт действовать со следующего.</p>}

        <label>
          Бюджет на период, ₽
          <input inputMode="numeric" value={budget} placeholder="без бюджета" onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="switch-row">
          <span>Автоматически начинать новый период</span>
          <input type="checkbox" className="switch" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
        </label>

        <button className="primary" disabled={busy || !name.trim()}>
          Сохранить
        </button>
      </form>

      <div className="danger-zone">
        {props.isOwner && (
          <button className="link danger" onClick={clear}>
            Очистить траты периода
          </button>
        )}
        <button className="link danger" onClick={remove}>
          {props.isOwner ? 'Удалить журнал' : 'Выйти из журнала'}
        </button>
      </div>
    </Sheet>
  );
}

const EXAMPLES = ['400 продукты', 'такси 650', 'кофе 280 и обед 450'];

function AddSheet(props: {
  roomId: number;
  colorOf: ColorOf;
  onClose: () => void;
  onAdded: (next: Overview, added: Operation[]) => void;
  onEdit: (op: Operation) => void;
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
              <li
                key={op.id}
                onClick={() => {
                  // правка открывается поверх; список здесь уже неактуален после смены категории
                  setAdded([]);
                  props.onEdit(op);
                }}
              >
                <CategoryBadge category={op.category} color={props.colorOf(op.category)} />
                <span className="grow">
                  <span className="title">{op.item}</span>
                  <small>{op.category?.name} · нажмите, чтобы изменить</small>
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
  const [amount, setAmount] = useState(String(op.amount / 100).replace('.', ','));
  const act = (action: Promise<unknown>) => action.then(props.onChanged).catch(props.fail).finally(props.onClose);

  // «1 250,5» → 125050 копеек; null — в поле не сумма
  const kopecks = Math.round(Number(amount.replace(/\s/g, '').replace(',', '.')) * 100);
  const valid = Number.isSafeInteger(kopecks) && kopecks > 0;
  const amountChanged = valid && kopecks !== op.amount;

  function saveAmount(e: FormEvent) {
    e.preventDefault();
    if (amountChanged) act(api.updateOperation(op.id, { amount: kopecks }));
  }

  return (
    <Sheet title={op.item} onClose={props.onClose}>
      {!sameWords(op) && <p className="muted original">Вы написали: «{op.description}»</p>}
      <form className="amount-form" onSubmit={saveAmount}>
        <label className="amount-field">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d\s.,]/g, ''))} aria-label="Сумма" />
          <span>₽</span>
        </label>
        {amountChanged && <button className="primary">Сохранить</button>}
      </form>
      {!valid && <p className="field-error">Введите сумму больше нуля</p>}
      <p className="muted">Куда отнести? Запомню для таких же трат.</p>
      <div className="chips">
        {props.categories.map((c) => (
          <button
            key={c.id}
            className={c.id === op.category?.id ? 'chip active' : 'chip'}
            // если сумму уже поправили, сохраняем её вместе с категорией
            onClick={() => act(api.updateOperation(op.id, { categoryId: c.id, ...(amountChanged ? { amount: kopecks } : {}) }))}
          >
            {c.emoji} {c.name}
          </button>
        ))}
      </div>
      <div className="danger-zone">
        <button className="link danger" onClick={() => act(api.remove(op.id))}>
          Удалить трату
        </button>
      </div>
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
    <Sheet title="Новый журнал" onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Название
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Отпуск в Сочи" maxLength={64} />
        </label>
        <div className="segmented">
          <button type="button" className={kind === 'month' ? 'active' : ''} onClick={() => setKind('month')}>
            Ежемесячный
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
        <p className="muted">Аватар и цвет можно выбрать в настройках журнала после создания.</p>
        <button className="primary" disabled={busy || !name.trim()}>
          Создать журнал
        </button>
      </form>
    </Sheet>
  );
}
