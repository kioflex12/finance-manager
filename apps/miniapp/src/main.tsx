import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tg } from './api';
import { App } from './App';
import './styles.css';

/** Своя тема приложения: светлая или тёмная вслед за Telegram, но с собственной палитрой. */
function applyTheme() {
  const dark = tg?.colorScheme ? tg.colorScheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const page = getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
  tg?.setHeaderColor?.(page);
  tg?.setBackgroundColor?.(page);
}

tg?.ready();
tg?.expand();
// вертикальный свайп Telegram закрывает миниапп и мешает прокрутке и шторкам
tg?.disableVerticalSwipes?.();
tg?.onEvent?.('themeChanged', applyTheme);
applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
