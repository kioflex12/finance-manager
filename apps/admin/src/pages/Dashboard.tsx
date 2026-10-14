import { useEffect, useState } from 'react';
import { api, money, plural, type Stats } from '../api';
import { DailyBars, StatCard, type PageProps } from '../ui';

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days ? `${days} д ${hours} ч` : `${hours} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

export function Dashboard({ fail }: PageProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const load = () => api.stats().then(setStats).catch(fail);
  useEffect(() => void load(), []);

  if (!stats) return <div className="muted">Загрузка…</div>;
  const { users, journals, operations, server } = stats;
  const memoryUsed = server.totalMemoryMb - server.freeMemoryMb;

  return (
    <>
      <div className="toolbar">
        <button className="secondary" onClick={() => void load()}>
          Обновить
        </button>
      </div>

      <div className="grid stats">
        <StatCard label="Пользователей" value={String(users.total)} note={`+${users.new1} сегодня · +${users.new7} за неделю`} />
        <StatCard label="Записывали сегодня" value={String(users.active.d1)} note={`${users.active.d7} за 7 дней · ${users.active.d30} за 30`} />
        <StatCard label="Трат сегодня" value={String(operations.count1)} note={money(operations.sum1)} />
        <StatCard label="Трат за 30 дней" value={String(operations.count30)} note={money(operations.sum30)} />
        <StatCard label="Журналов" value={String(journals.total)} note={`${journals.shared} общих · ${journals.groups} в группах`} />
        <StatCard label="Всего трат" value={String(operations.total)} note={money(operations.sum)} />
        <StatCard label="Заходили сегодня" value={String(users.seen1)} note={`${users.seen7} за неделю`} />
        <StatCard label="Заблокировано" value={String(users.blocked)} />
      </div>

      <div className="grid two">
        <section className="card">
          <h3>Траты по дням</h3>
          <DailyBars
            data={stats.daily}
            pick={(d) => d.operations}
            describe={(d) => `${d.operations} ${plural(d.operations, 'трата', 'траты', 'трат')} · записывали ${d.active} чел.`}
          />
        </section>
        <section className="card">
          <h3>Новые пользователи</h3>
          <DailyBars data={stats.daily} pick={(d) => d.users} describe={(d) => `${d.users} ${plural(d.users, 'новый', 'новых', 'новых')}`} />
        </section>
      </div>

      <div className="grid two">
        <section className="card">
          <h3>Частые траты за 30 дней</h3>
          <table>
            <thead>
              <tr>
                <th>Позиция</th>
                <th className="num">Раз</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {stats.topItems.map((t) => (
                <tr key={t.item}>
                  <td>{t.item}</td>
                  <td className="num">{t.count}</td>
                  <td className="num">{money(t.sum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>Категории за 30 дней</h3>
          <table>
            <thead>
              <tr>
                <th>Категория</th>
                <th className="num">Трат</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {stats.topCategories.map((c) => (
                <tr key={c.name}>
                  <td>
                    {c.emoji} {c.name}
                  </td>
                  <td className="num">{c.count}</td>
                  <td className="num">{money(c.sum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h3>Сервер</h3>
        <div className="grid stats compact">
          <StatCard label="Работает без перезапуска" value={uptime(server.uptimeSec)} />
          <StatCard label="Память сервера" value={`${memoryUsed} / ${server.totalMemoryMb} МБ`} note={`приложение: ${server.appMemoryMb} МБ`} />
          {server.disk && (
            <StatCard
              label="Диск"
              value={`${((server.disk.totalMb - server.disk.freeMb) / 1024).toFixed(1)} / ${(server.disk.totalMb / 1024).toFixed(1)} ГБ`}
              note={`свободно ${(server.disk.freeMb / 1024).toFixed(1)} ГБ`}
            />
          )}
          {server.dbSizeMb !== null && <StatCard label="База данных" value={`${server.dbSizeMb} МБ`} />}
          <StatCard label="Нагрузка процессора" value={server.load.toFixed(2)} note="среднее за минуту" />
          <StatCard
            label="Запросы к LLM"
            value={String(server.llm.calls)}
            note={`ошибок ${server.llm.failures} · в среднем ${server.llm.avgMs} мс`}
          />
          <StatCard label="Распознавание голоса" value={String(server.stt.calls)} note={`ошибок ${server.stt.failures}`} />
        </div>
        <p className="muted small">Счётчики LLM и голоса считаются с последнего перезапуска сервера.</p>
      </section>
    </>
  );
}
