import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from './api';
import { Audit } from './pages/Audit';
import { Broadcast } from './pages/Broadcast';
import { Dashboard } from './pages/Dashboard';
import { Journals } from './pages/Journals';
import { Users } from './pages/Users';
import { Field } from './ui';

/** Разделы админки — это и пути в адресной строке: /users, /journals… */
const PAGES = [
  { path: '/', label: 'Сводка', icon: '📊' },
  { path: '/users', label: 'Пользователи', icon: '👥' },
  { path: '/journals', label: 'Журналы', icon: '📒' },
  { path: '/broadcast', label: 'Рассылка', icon: '📣' },
  { path: '/audit', label: 'Журнал действий', icon: '🧾' },
] as const;

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: string) => {
    if (next !== location.pathname) history.pushState(null, '', next);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);
  return [path, go];
}

export function App() {
  // undefined — ещё проверяем сессию, null — не вошёл, строка — логин
  const [admin, setAdmin] = useState<string | null | undefined>();
  const [path, go] = usePath();
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    api
      .me()
      .then((r) => setAdmin(r.login))
      .catch(() => setAdmin(null));
    const onLogout = () => setAdmin(null);
    window.addEventListener('admin:logout', onLogout);
    return () => window.removeEventListener('admin:logout', onLogout);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((text: string) => setToast({ text }), []);
  const fail = useCallback((err: unknown) => setToast({ text: errorText(err), error: true }), []);

  if (admin === undefined) return <div className="splash">Загрузка…</div>;
  if (admin === null) {
    return <LoginScreen onSignedIn={setAdmin} />;
  }

  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];
  const props = { notify, fail };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">₽</span>
          <div>
            <b>Finance Manager</b>
            <small>админка</small>
          </div>
        </div>
        <nav>
          {PAGES.map((p) => (
            <a
              key={p.path}
              href={p.path}
              className={p.path === page.path ? 'active' : ''}
              onClick={(e) => {
                e.preventDefault();
                go(p.path);
              }}
            >
              <span>{p.icon}</span>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="whoami">
          <span>{admin}</span>
          <button
            className="link"
            onClick={() =>
              api
                .logout()
                .catch(() => {})
                .finally(() => setAdmin(null))
            }
          >
            Выйти
          </button>
        </div>
      </aside>
      <main className="content">
        <h1>{page.label}</h1>
        {page.path === '/' && <Dashboard {...props} />}
        {page.path === '/users' && <Users {...props} />}
        {page.path === '/journals' && <Journals {...props} />}
        {page.path === '/broadcast' && <Broadcast {...props} />}
        {page.path === '/audit' && <Audit {...props} />}
      </main>
      {toast && <div className={toast.error ? 'toast error' : 'toast'}>{toast.text}</div>}
    </div>
  );
}

/** Вход: только логин и пароль, заданные в настройках сервера. */
function LoginScreen({ onSignedIn }: { onSignedIn: (login: string) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn((await api.login(login, password)).login);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="logo">₽</span>
          <div>
            <b>Finance Manager</b>
            <small>админка</small>
          </div>
        </div>
        <Field label="Логин">
          <input autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
        </Field>
        <Field label="Пароль">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy}>
          Войти
        </button>
      </form>
    </div>
  );
}
