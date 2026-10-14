import { useState } from 'react';
import { api, plural } from '../api';
import type { PageProps } from '../ui';

export function Broadcast({ notify, fail }: PageProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!confirm('Отправить это сообщение всем пользователям бота?')) return;
    setBusy(true);
    await api
      .broadcast(text)
      .then((r) => {
        setText('');
        notify(`Рассылка запущена: ${r.recipients} ${plural(r.recipients, 'получатель', 'получателя', 'получателей')}`);
      })
      .catch(fail)
      .finally(() => setBusy(false));
  }

  return (
    <section className="card narrow">
      <p className="muted">
        Сообщение придёт от бота всем, кто им пользовался, кроме заблокированных. Отправляется в фоне — Telegram пропускает около 20 сообщений в
        секунду. Рассылка попадёт в журнал действий.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder="Например: «Добавили правку суммы — нажмите на трату в приложении»" />
      <div className="toolbar end">
        <span className="muted">{text.length} / 4000</span>
        <button className="primary" disabled={busy || !text.trim() || text.length > 4000} onClick={send}>
          Отправить всем
        </button>
      </div>
    </section>
  );
}
