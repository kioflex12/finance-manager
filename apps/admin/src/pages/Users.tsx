import { useCallback, useEffect, useState } from 'react';
import { api, date, dateTime, money, plural, since, type User, type UserDetails } from '../api';
import { Drawer, Empty, StatCard, type PageProps } from '../ui';

export function Users({ notify, fail }: PageProps) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<User[] | null>(null);
  const [opened, setOpened] = useState<number | null>(null);

  const load = useCallback(() => api.users(query).then((r) => setUsers(r.users)).catch(fail), [query, fail]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <div className="toolbar">
        <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по имени или Telegram id" />
        {users && <span className="muted">{users.length} в списке</span>}
      </div>
      <section className="card flush">
        <table className="clickable">
          <thead>
            <tr>
              <th>Пользователь</th>
              <th>Telegram id</th>
              <th className="num">Трат</th>
              <th className="num">Сумма</th>
              <th className="num">Журналов</th>
              <th>Последняя трата</th>
              <th>Заходил</th>
              <th>С нами с</th>
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id} onClick={() => setOpened(u.id)}>
                <td>
                  <span className={u.blocked ? 'avatar blocked' : 'avatar'}>{u.name.charAt(0).toUpperCase()}</span>
                  {u.name} {u.blocked && <span className="badge danger">заблокирован</span>}
                </td>
                <td className="mono">{u.tgId}</td>
                <td className="num">{u.operations}</td>
                <td className="num">{money(u.sum)}</td>
                <td className="num">{u.journals}</td>
                <td>{date(u.lastOperationAt)}</td>
                <td>{since(u.lastSeenAt)}</td>
                <td>{date(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {users?.length === 0 && <Empty>Никого не нашлось</Empty>}
      </section>
      {opened !== null && <UserDrawer id={opened} onClose={() => setOpened(null)} onChanged={() => void load()} notify={notify} fail={fail} />}
    </>
  );
}

function UserDrawer(props: { id: number; onClose: () => void; onChanged: () => void } & PageProps) {
  const { id, notify, fail } = props;
  const [details, setDetails] = useState<UserDetails | null>(null);
  const [text, setText] = useState('');
  const load = useCallback(() => api.user(id).then(setDetails).catch(fail), [id, fail]);
  useEffect(() => void load(), [load]);

  if (!details) return null;
  const { user } = details;

  async function toggleBlock() {
    const question = user.blocked
      ? `Разблокировать ${user.name}?`
      : `Заблокировать ${user.name}? Бот перестанет отвечать, приложение не откроется, напоминания и сводки не придут.`;
    if (!confirm(question)) return;
    await api
      .block(user.id, !user.blocked)
      .then(() => notify(user.blocked ? 'Пользователь разблокирован' : 'Пользователь заблокирован'))
      .then(load)
      .then(props.onChanged)
      .catch(fail);
  }

  async function remove() {
    if (!confirm(`Удалить ${user.name} и все данные: журналы, где он владелец, и его траты в общих журналах? Отменить нельзя.`)) return;
    await api
      .deleteUser(user.id)
      .then(() => notify('Пользователь удалён'))
      .then(props.onChanged)
      .then(props.onClose)
      .catch(fail);
  }

  async function send() {
    await api
      .message(user.id, text)
      .then(() => {
        setText('');
        notify('Сообщение отправлено');
      })
      .catch(fail);
  }

  return (
    <Drawer title={user.name} onClose={props.onClose}>
      <p className="muted">
        Telegram id <span className="mono">{user.tgId}</span> · с {date(user.createdAt)} · заходил {since(user.lastSeenAt)}
        {user.blocked && (
          <>
            {' '}
            · <span className="badge danger">заблокирован</span>
          </>
        )}
      </p>
      <div className="grid stats compact">
        <StatCard label="Трат" value={String(user.operations)} note={money(user.sum)} />
        <StatCard label="Журналов" value={String(user.journals)} note={`последняя трата ${date(user.lastOperationAt)}`} />
      </div>

      <h3>Журналы</h3>
      {details.journals.length ? (
        <ul className="list">
          {details.journals.map((j) => (
            <li key={j.id}>
              <span>
                {j.emoji} {j.name}
              </span>
              <span className="muted">
                {j.owner ? 'владелец' : 'участник'} · {j.members} {plural(j.members, 'участник', 'участника', 'участников')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Нет журналов</Empty>
      )}

      <h3>Последние траты</h3>
      {details.recent.length ? (
        <table>
          <tbody>
            {details.recent.map((op) => (
              <tr key={op.id}>
                <td>{op.item}</td>
                <td className="muted">{op.journal}</td>
                <td className="muted">{dateTime(op.createdAt)}</td>
                <td className="num">{money(op.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Трат пока нет</Empty>
      )}

      <h3>Написать от имени бота</h3>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Текст сообщения" />
      <button className="primary" disabled={!text.trim()} onClick={send}>
        Отправить
      </button>

      <div className="danger-zone">
        <button className="secondary" onClick={toggleBlock}>
          {user.blocked ? 'Разблокировать' : 'Заблокировать'}
        </button>
        <button className="danger" onClick={remove}>
          Удалить пользователя и данные
        </button>
      </div>
    </Drawer>
  );
}
