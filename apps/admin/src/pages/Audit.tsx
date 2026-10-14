import { useEffect, useState } from 'react';
import { api, dateTime, type AuditEntry } from '../api';
import { Empty, type PageProps } from '../ui';

const ACTIONS: Record<string, string> = {
  login: 'Вход',
  login_failed: 'Неудачный вход',
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
  if (d.login) return `логин «${String(d.login)}»`;
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
            <th>Действие</th>
            <th>Подробности</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {entries?.map((e) => (
            <tr key={e.id} className={e.action === 'login_failed' ? 'warn' : ''}>
              <td>{dateTime(e.createdAt)}</td>
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
