import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, money, type Category, type Me, type NewRoom, type Operation, type Period, type RoomView } from './api';

type Screen =
  | { type: 'home' }
  | { type: 'category'; category: Category | null }
  | { type: 'rooms' }
  | { type: 'newRoom' }
  | { type: 'history' };

const ERRORS: Record<string, string> = {
  not_understood: 'Не нашёл сумму. Например: «400 продукты»',
  no_period: 'Срок комнаты закончился — начните новый период',
  unauthorized: 'Откройте приложение из Telegram',
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  // undefined — текущий период, число — просмотр периода из истории
  const [periodId, setPeriodId] = useState<number | undefined>();
  const [view, setView] = useState<RoomView | null>(null);
  const [screen, setScreen] = useState<Screen>({ type: 'home' });
  const [error, setError] = useState('');

  const fail = useCallback((err: unknown) => {
    const code = err instanceof ApiError ? err.code : '';
    setError(ERRORS[code] ?? 'Что-то пошло не так. Попробуйте ещё раз');
    window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('error');
  }, []);

  useEffect(() => {
    (async () => {
      // ссылка-приглашение или кнопка из группового чата открывают конкретную комнату
      const start = window.Telegram?.WebApp.initDataUnsafe.start_param ?? '';
      let target: number | null = null;
      if (start.startsWith('join_')) target = (await api.join(start.slice(5)).catch(() => null))?.room.id ?? null;
      if (start.startsWith('room_')) target = Number(start.slice(5));
      const loaded = await api.me();
      setMe(loaded);
      setRoomId(loaded.rooms.some((r) => r.id === target) ? target : loaded.activeRoomId);
    })().catch(fail);
  }, [fail]);

  const reload = useCallback(async () => {
    if (roomId) setView(await api.room(roomId, periodId));
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

  async function openRoom(id: number) {
    setRoomId(id);
    setPeriodId(undefined);
    setScreen({ type: 'home' });
    await api.updateRoom(id, { active: true }).catch(fail);
  }

  if (!me || !view) return <div className="center">{error || 'Загрузка…'}</div>;

  return (
    <>
      {screen.type === 'home' && (
        <Home
          view={view}
          viewingHistory={periodId !== undefined}
          onChanged={(next) => setView({ ...view, ...next })}
          onReload={() => reload().catch(fail)}
          onOpenCategory={(category) => setScreen({ type: 'category', category })}
          onOpenRooms={() => setScreen({ type: 'rooms' })}
          onOpenHistory={() => setScreen({ type: 'history' })}
          onBackToCurrent={() => setPeriodId(undefined)}
          fail={fail}
        />
      )}
      {screen.type === 'category' && view.period && (
        <CategoryScreen
          view={view}
          period={view.period}
          category={screen.category}
          onBack={() => {
            setScreen({ type: 'home' });
            reload().catch(fail);
          }}
          fail={fail}
        />
      )}
      {screen.type === 'rooms' && (
        <Rooms
          me={me}
          view={view}
          onBack={() => setScreen({ type: 'home' })}
          onOpen={openRoom}
          onNew={() => setScreen({ type: 'newRoom' })}
          onReload={() => reload().catch(fail)}
          fail={fail}
        />
      )}
      {screen.type === 'newRoom' && (
        <NewRoomForm
          onBack={() => setScreen({ type: 'rooms' })}
          onCreate={async (input) => {
            const { room } = await api.createRoom(input);
            setMe({ ...me, rooms: [...me.rooms, room] });
            await openRoom(room.id);
          }}
          fail={fail}
        />
      )}
      {screen.type === 'history' && (
        <History
          roomId={view.room.id}
          onBack={() => setScreen({ type: 'home' })}
          onOpen={(p) => {
            setPeriodId(p.closedAt ? p.id : undefined);
            setScreen({ type: 'home' });
          }}
          fail={fail}
        />
      )}
      {error && <div className="toast">{error}</div>}
    </>
  );
}

type Fail = (err: unknown) => void;

function Home(props: {
  view: RoomView;
  viewingHistory: boolean;
  onChanged: (next: Partial<RoomView>) => void;
  onReload: () => void;
  onOpenCategory: (category: Category | null) => void;
  onOpenRooms: () => void;
  onOpenHistory: () => void;
  onBackToCurrent: () => void;
  fail: Fail;
}) {
  const { view, viewingHistory, fail } = props;
  const { room, period, stats, budget } = view;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Operation[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const { operations, ...next } = await api.add(room.id, text);
      setAdded(operations);
      setText('');
      props.onChanged(next);
      window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('success');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    await Promise.all(added.map((op) => api.remove(op.id))).catch(fail);
    setAdded([]);
    props.onReload();
  }

  const spent = budget ? Math.min(100, (stats!.total / budget.budget) * 100) : 0;

  return (
    <div className="page">
      <header className="bar">
        <button className="link" onClick={props.onOpenRooms}>
          {room.name} ▾
        </button>
        <button className="link muted" onClick={props.onOpenHistory}>
          {period?.label ?? 'Периоды'}
        </button>
      </header>

      {!period ? (
        <div className="card center">
          <p>Срок комнаты закончился.</p>
          <button className="primary" onClick={() => api.startPeriod(room.id).then(props.onReload).catch(fail)}>
            Начать новый период
          </button>
        </div>
      ) : (
        <>
          <section className="total">
            <div className="muted">{viewingHistory ? 'Потрачено за период' : 'Потрачено'}</div>
            <div className="amount">{money(stats!.total)}</div>
            {budget && (
              <>
                <div className="progress">
                  <div className={budget.left < 0 ? 'over' : ''} style={{ width: `${spent}%` }} />
                </div>
                <div className="muted">
                  {budget.left >= 0
                    ? `Осталось ${money(budget.left)} · ≈${money(budget.perDay)} в день`
                    : `Перерасход ${money(-budget.left)}`}
                </div>
              </>
            )}
            {viewingHistory && (
              <button className="link" onClick={props.onBackToCurrent}>
                ← К текущему периоду
              </button>
            )}
          </section>

          <ul className="list">
            {stats!.byCategory.map(({ category, total, count }) => (
              <li key={category?.id ?? 0} onClick={() => props.onOpenCategory(category)}>
                <span className="emoji">{category?.emoji ?? '⏳'}</span>
                <span className="grow">
                  {category?.name ?? 'Без категории'}
                  <small>{count} шт.</small>
                </span>
                <b>{money(total)}</b>
              </li>
            ))}
            {!stats!.count && <li className="empty">Пока пусто. Напишите первую трату ниже.</li>}
          </ul>

          {stats!.byMember.length > 1 && (
            <ul className="list">
              {stats!.byMember.map((m) => (
                <li key={m.userId} className="static">
                  <span className="emoji">👤</span>
                  <span className="grow">{m.name}</span>
                  <b>{money(m.total)}</b>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {period && !viewingHistory && (
        <footer className="composer">
          {added.length > 0 && (
            <div className="added">
              <span>
                {added.map((op) => `${money(op.amount)} → ${op.category?.emoji ?? ''} ${op.category?.name ?? ''}`).join(', ')}
              </span>
              <button className="link" onClick={undo}>
                Отменить
              </button>
            </div>
          )}
          <form onSubmit={submit}>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="400 продукты"
              enterKeyHint="send"
            />
            <button className="primary" disabled={busy || !text.trim()}>
              {busy ? '…' : '+'}
            </button>
          </form>
        </footer>
      )}
    </div>
  );
}

function CategoryScreen(props: { view: RoomView; period: Period; category: Category | null; onBack: () => void; fail: Fail }) {
  const { view, period, category, fail } = props;
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [editing, setEditing] = useState<Operation | null>(null);

  const load = useCallback(
    () => api.operations(view.room.id, period.id, category?.id ?? null).then((r) => setOperations(r.operations)),
    [view.room.id, period.id, category],
  );
  useEffect(() => void load().catch(fail), [load, fail]);

  const act = (action: Promise<unknown>) =>
    action
      .then(load)
      .catch(fail)
      .finally(() => setEditing(null));

  return (
    <div className="page">
      <header className="bar">
        <button className="link" onClick={props.onBack}>
          ← Назад
        </button>
        <span>
          {category?.emoji} {category?.name ?? 'Без категории'}
        </span>
      </header>
      <ul className="list">
        {operations?.map((op) => (
          <li key={op.id} onClick={() => setEditing(op)}>
            <span className="grow">
              {op.description}
              <small>
                {new Date(op.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                {view.members.length > 1 && ` · ${op.userName}`}
              </small>
            </span>
            <b>{money(op.amount)}</b>
          </li>
        ))}
        {operations?.length === 0 && <li className="empty">Здесь больше ничего нет.</li>}
      </ul>

      {editing && (
        <div className="sheet" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <p>
              <b>{money(editing.amount)}</b> · {editing.description}
            </p>
            <p className="muted">Куда отнести? Запомню для таких же трат.</p>
            <div className="chips">
              {view.categories.map((c) => (
                <button
                  key={c.id}
                  className={c.id === editing.category?.id ? 'chip active' : 'chip'}
                  onClick={() => act(api.setCategory(editing.id, c.id))}
                >
                  {c.emoji} {c.name}
                </button>
              ))}
            </div>
            <button className="link danger" onClick={() => act(api.remove(editing.id))}>
              Удалить трату
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Rooms(props: {
  me: Me;
  view: RoomView;
  onBack: () => void;
  onOpen: (id: number) => void;
  onNew: () => void;
  onReload: () => void;
  fail: Fail;
}) {
  const { me, view, fail } = props;
  const { room } = view;
  const [budget, setBudget] = useState(room.budget ? String(room.budget / 100) : '');
  const invite = me.botUsername ? `https://t.me/${me.botUsername}?start=join_${room.inviteCode}` : '';

  const save = (patch: { budget?: number | null; autoRenew?: boolean }) =>
    api.updateRoom(room.id, patch).then(props.onReload).catch(fail);

  return (
    <div className="page">
      <header className="bar">
        <button className="link" onClick={props.onBack}>
          ← Назад
        </button>
        <span>Комнаты</span>
      </header>
      <ul className="list">
        {me.rooms.map((r) => (
          <li key={r.id} onClick={() => props.onOpen(r.id)}>
            <span className="emoji">{r.id === room.id ? '●' : '○'}</span>
            <span className="grow">
              {r.name}
              <small>{r.periodKind === 'month' ? 'ежемесячная' : `на ${r.periodDays} дн.`}</small>
            </span>
          </li>
        ))}
        <li onClick={props.onNew}>
          <span className="emoji">＋</span>
          <span className="grow">Новая комната</span>
        </li>
      </ul>

      <h3>{room.name}</h3>
      <div className="card">
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
        <label className="row">
          <input type="checkbox" checked={room.autoRenew} onChange={(e) => save({ autoRenew: e.target.checked })} />
          Автоматически начинать новый период
        </label>
        <p className="muted">Участники: {view.members.map((m) => m.name).join(', ')}</p>
        {invite && (
          <button
            className="primary"
            onClick={() =>
              window.Telegram?.WebApp.openTelegramLink(
                `https://t.me/share/url?url=${encodeURIComponent(invite)}&text=${encodeURIComponent(`Давай вести траты вместе: «${room.name}»`)}`,
              )
            }
          >
            Пригласить в комнату
          </button>
        )}
      </div>
    </div>
  );
}

function NewRoomForm(props: { onBack: () => void; onCreate: (room: NewRoom) => Promise<void>; fail: Fail }) {
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
    <form className="page" onSubmit={submit}>
      <header className="bar">
        <button type="button" className="link" onClick={props.onBack}>
          ← Назад
        </button>
        <span>Новая комната</span>
      </header>
      <div className="card">
        <label>
          Название
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Отпуск в Сочи" maxLength={64} />
        </label>
        <div className="chips">
          <button type="button" className={kind === 'month' ? 'chip active' : 'chip'} onClick={() => setKind('month')}>
            Ежемесячная
          </button>
          <button type="button" className={kind === 'days' ? 'chip active' : 'chip'} onClick={() => setKind('days')}>
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
          <input
            inputMode="numeric"
            value={budget}
            placeholder="необязательно"
            onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button className="primary" disabled={busy || !name.trim()}>
          Создать
        </button>
      </div>
    </form>
  );
}

function History(props: { roomId: number; onBack: () => void; onOpen: (period: Period) => void; fail: Fail }) {
  const { roomId, fail } = props;
  const [periods, setPeriods] = useState<Period[] | null>(null);
  useEffect(() => {
    api
      .periods(roomId)
      .then((r) => setPeriods(r.periods))
      .catch(fail);
  }, [roomId, fail]);

  return (
    <div className="page">
      <header className="bar">
        <button className="link" onClick={props.onBack}>
          ← Назад
        </button>
        <span>Периоды</span>
      </header>
      <ul className="list">
        {periods?.map((p) => (
          <li key={p.id} onClick={() => props.onOpen(p)}>
            <span className="grow">
              {p.label}
              <small>{p.closedAt ? 'завершён' : 'идёт сейчас'}</small>
            </span>
            <b>{money(p.total ?? 0)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
