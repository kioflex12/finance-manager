import { useEffect, useState, type ReactNode } from 'react';
import type { DailyPoint } from './api';

export interface PageProps {
  notify: (text: string) => void;
  fail: (err: unknown) => void;
}

export function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card stat">
      <span className="muted">{label}</span>
      <b>{value}</b>
      {note && <small>{note}</small>}
    </div>
  );
}

/** Боковая панель с подробностями; закрывается крестиком, кликом по фону и Esc. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Столбики по дням одним цветом. Наведение (или нажатие) показывает день и значение
 * в подписи над графиком; без наведения — последний день.
 */
export function DailyBars(props: { data: DailyPoint[]; pick: (d: DailyPoint) => number; describe: (d: DailyPoint) => string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const values = props.data.map(props.pick);
  const max = Math.max(1, ...values);
  const index = hovered ?? props.data.length - 1;
  const point = props.data[index];
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  return (
    <div className="daily">
      <div className="daily-caption">
        <b>{point ? label(point.day) : ''}</b>
        <span className="muted">{point ? props.describe(point) : ''}</span>
      </div>
      <div className="daily-bars" role="img" aria-label="Значения по дням за 30 дней" onMouseLeave={() => setHovered(null)}>
        {props.data.map((d, i) => (
          <button
            key={d.day}
            className={i === index ? 'active' : ''}
            aria-label={`${label(d.day)}: ${props.describe(d)}`}
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setHovered(i)}
            onClick={() => setHovered(i)}
          >
            <span style={{ height: `${values[i] ? Math.max(4, (values[i]! / max) * 100) : 0}%` }} />
          </button>
        ))}
      </div>
      <div className="daily-axis muted">
        <span>{props.data[0] ? label(props.data[0].day) : ''}</span>
        <span>максимум {max}</span>
        <span>сегодня</span>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label} {hint && <small>· {hint}</small>}
      </span>
      {children}
    </label>
  );
}
