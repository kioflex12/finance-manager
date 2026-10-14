import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, dateTime, since, type Admin, type AuditEntry } from '../api';
import { Empty, Field, type PageProps } from '../ui';

export function Admins({ me, notify, fail }: PageProps & { me: Admin }) {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [invite, setInvite] = useState<{ link: string; expiresAt: string } | null>(null);
  const load = useCallback(() => api.admins().then((r) => setAdmins(r.admins)).catch(fail), [fail]);
  useEffect(() => void load(), [load]);

  async function createInvite() {
    await api
      .invite()
      .then((r) => setInvite({ link: `${location.origin}/register?invite=${encodeURIComponent(r.code)}`, expiresAt: r.expiresAt }))
      .catch(fail);
  }

  async function remove(admin: Admin) {
    if (!confirm(`Удалить администратора ${admin.name} (${admin.login})? Он сразу потеряет доступ.`)) return;
    await api
      .removeAdmin(admin.id)
      .then(() => notify('Администратор удалён'))
      .then(load)
      .catch(fail);
  }

  return (
    <>
      <section className="card">
        <h3>Пригласить администратора</h3>
        <p className="muted">
          Регистрация в админке открыта только по приглашению. Ссылка одноразовая, действует 3 дня и показывается один раз — сразу отправьте её
          человеку.
        </p>
        {invite ? (
          <div className="invite">
            <input readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="secondary"
              onClick={() =>
                navigator.clipboard
                  .writeText(invite.link)
                  .then(() => notify('Ссылка скопирована'))
                  .catch(() => notify('Скопируйте ссылку вручную'))
              }
            >
              Копировать
            </button>
            <span className="muted small">действует до {dateTime(invite.expiresAt)}</span>
          </div>
        ) : (
          <button className="primary" onClick={createInvite}>
            Создать приглашение
          </button>
        )}
      </section>

      <section className="card flush">
        <table>
          <thead>
            <tr>
              <th>Имя</th>
              <th>Логин</th>
              <th>Последний вход</th>
              <th>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {admins?.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name} {a.id === me.id && <span className="badge">вы</span>}
                </td>
                <td className="mono">{a.login}</td>
                <td>{since(a.lastLoginAt)}</td>
                <td>{since(a.createdAt)}</td>
                <td className="num">
                  {a.id !== me.id && (
                    <button className="link danger" onClick={() => remove(a)}>
                      Удалить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

const ACTIONS: Record<string, string> = {
  register: 'Регистрация',
  login: 'Вход',
  login_failed: 'Неудачный вход',
  password_changed: 'Смена пароля',
  invite_created: 'Создано приглашение',
  admin_removed: 'Удалён администратор',
  user_blocked: 'Заблокирован пользователь',
  user_unblocked: 'Разблокирован пользователь',
  user_messaged: 'Сообщение пользователю',
  user_deleted: 'Удалён пользователь',
  journal_deleted: 'Удалён журнал',
  broadcast: 'Рассылка',
};

function describe(entry: AuditEntry): string {
  const d = entry.details;
  if (d.name) return String(d.name) + (d.text ? `: «${String(d.text).slice(0, 80)}»` : '');
  if (d.text) return `«${String(d.text).slice(0, 80)}» · ${d.recipients ?? 0} получателей`;
  if (d.login) return String(d.login);
  return '';
}

export function Audit({ fail }: PageProps) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => void api.audit().then((r) => setEntries(r.entries)).catch(fail), [fail]);

  return (
    <section className="card flush">
      <table>
        <thead>
          <tr>
            <th>Когда</th>
            <th>Кто</th>
            <th>Действие</th>
            <th>Подробности</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {entries?.map((e) => (
            <tr key={e.id} className={e.action === 'login_failed' ? 'warn' : ''}>
              <td>{dateTime(e.createdAt)}</td>
              <td>{e.admin ?? '—'}</td>
              <td>{ACTIONS[e.action] ?? e.action}</td>
              <td className="muted">{describe(e)}</td>
              <td className="mono muted">{e.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries?.length === 0 && <Empty>Пока ничего не происходило</Empty>}
    </section>
  );
}

export function Profile({ me, notify, fail }: PageProps & { me: Admin }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) {
      notify('Новые пароли не совпадают');
      return;
    }
    await api
      .changePassword(current, next)
      .then(() => {
        setCurrent('');
        setNext('');
        setRepeat('');
        notify('Пароль изменён. Остальные устройства разлогинены');
      })
      .catch(fail);
  }

  return (
    <section className="card narrow">
      <p>
        <b>{me.name}</b> · <span className="mono">{me.login}</span>
      </p>
      <form className="form" onSubmit={submit}>
        <h3>Смена пароля</h3>
        <Field label="Текущий пароль">
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="Новый пароль" hint="минимум 8 символов">
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
        </Field>
        <Field label="Новый пароль ещё раз">
          <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required minLength={8} />
        </Field>
        <button className="primary">Сменить пароль</button>
      </form>
    </section>
  );
}
