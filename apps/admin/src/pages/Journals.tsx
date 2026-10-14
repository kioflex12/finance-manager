import { useCallback, useEffect, useState } from 'react';
import { api, date, money, plural, since, type Journal, type JournalDetails } from '../api';
import { Drawer, Empty, StatCard, type PageProps } from '../ui';

export function Journals({ notify, fail }: PageProps) {
  const [journals, setJournals] = useState<Journal[] | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const load = useCallback(() => api.journals().then((r) => setJournals(r.journals)).catch(fail), [fail]);
  useEffect(() => void load(), [load]);

  return (
    <>
      <section className="card flush">
        <table className="clickable">
          <thead>
            <tr>
              <th>Журнал</th>
              <th>Владелец</th>
              <th className="num">Участников</th>
              <th className="num">Трат всего</th>
              <th className="num">За текущий период</th>
              <th>Последняя трата</th>
            </tr>
          </thead>
          <tbody>
            {journals?.map((j) => (
              <tr key={j.id} onClick={() => setOpened(j.id)}>
                <td>
                  {j.emoji ?? '📒'} {j.name} {j.group && <span className="badge">группа</span>}
                </td>
                <td>{j.owner}</td>
                <td className="num">{j.members}</td>
                <td className="num">{j.operations}</td>
                <td className="num">{money(j.periodSum)}</td>
                <td>{since(j.lastOperationAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {journals?.length === 0 && <Empty>Журналов пока нет</Empty>}
      </section>
      {opened !== null && <JournalDrawer id={opened} onClose={() => setOpened(null)} onChanged={() => void load()} notify={notify} fail={fail} />}
    </>
  );
}

function JournalDrawer(props: { id: number; onClose: () => void; onChanged: () => void } & PageProps) {
  const { id, notify, fail } = props;
  const [details, setDetails] = useState<JournalDetails | null>(null);
  useEffect(() => void api.journal(id).then(setDetails).catch(fail), [id, fail]);
  if (!details) return null;
  const { room, stats } = details;

  async function remove() {
    if (!confirm(`Удалить журнал «${room.name}» со всеми тратами и историей? Отменить нельзя.`)) return;
    await api
      .deleteJournal(room.id)
      .then(() => notify('Журнал удалён'))
      .then(props.onChanged)
      .then(props.onClose)
      .catch(fail);
  }

  return (
    <Drawer title={`${room.emoji ?? '📒'} ${room.name}`} onClose={props.onClose}>
      <p className="muted">
        {room.periodKind === 'month' ? 'ежемесячный' : `на ${room.periodDays} дн.`} · {room.budget ? `бюджет ${money(room.budget)}` : 'без бюджета'}
      </p>
      <div className="grid stats compact">
        <StatCard label="Текущий период" value={money(stats?.total ?? 0)} note={`${stats?.count ?? 0} ${plural(stats?.count ?? 0, 'трата', 'траты', 'трат')}`} />
        <StatCard label="Участников" value={String(details.members.length)} note={details.members.map((m) => m.name).join(', ')} />
      </div>

      <h3>Категории в текущем периоде</h3>
      {stats?.byCategory.length ? (
        <table>
          <tbody>
            {stats.byCategory.map((c) => (
              <tr key={c.category?.name ?? 'none'}>
                <td>
                  {c.category?.emoji ?? '⏳'} {c.category?.name ?? 'Без категории'}
                </td>
                <td className="num muted">{c.count}</td>
                <td className="num">{money(c.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Трат в этом периоде нет</Empty>
      )}

      <h3>Периоды</h3>
      <table>
        <tbody>
          {details.periods.map((p) => (
            <tr key={p.id}>
              <td>
                {date(p.startsAt)} — {date(new Date(new Date(p.endsAt).getTime() - 1).toISOString())}
              </td>
              <td className="muted">{p.closedAt ? 'завершён' : 'идёт'}</td>
              <td className="num">{money(p.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="danger-zone">
        <button className="danger" onClick={remove}>
          Удалить журнал
        </button>
      </div>
    </Drawer>
  );
}
