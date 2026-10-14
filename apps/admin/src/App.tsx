import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorText, type Admin } from './api';
import { Admins, Audit, Profile } from './pages/Access';
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
  { path: '/admins', label: 'Администраторы', icon: '🛡' },
  { path: '/audit', label: 'Журнал действий', icon: '🧾' },
  { path: '/profile', label: 'Профиль', icon: '👤' },
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
  // undefined — ещё проверяем сессию, null — не вошёл
  const [admin, setAdmin] = useState<Admin | null | undefined>();
  const [path, go] = usePath();
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    api
      .me()
      .then((r) => setAdmin(r.admin))
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
    return (
      <AuthScreen
        onSignedIn={(signedIn) => {
          setAdmin(signedIn);
          go(path.startsWith('/register') ? '/' : path);
        }}
      />
    );
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
          <span>{admin.name}</span>
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
        {page.path === '/admins' && <Admins {...props} me={admin} />}
        {page.path === '/audit' && <Audit {...props} />}
        {page.path === '/profile' && <Profile {...props} me={admin} />}
      </main>
      {toast && <div className={toast.error ? 'toast error' : 'toast'}>{toast.text}</div>}
    </div>
  );
}

/** Вход; регистрация — только по приглашению (ссылка /register?invite=…) или кодом установки для первого админа. */
function AuthScreen({ onSignedIn }: { onSignedIn: (admin: Admin) => void }) {
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<'login' | 'register'>(location.pathname.startsWith('/register') ? 'register' : 'login');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [login, setLogin] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState(params.get('invite') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .setup()
      .then((r) => {
        setNeedsSetup(r.needsSetup);
        if (r.needsSetup) setMode('register');
      })
      .catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = mode === 'login' ? await api.login(login, password) : await api.register({ login, name, password, invite });
      if (mode === 'register') history.replaceState(null, '', '/');
      onSignedIn(result.admin);
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
        <h2>{mode === 'login' ? 'Вход' : needsSetup ? 'Первый администратор' : 'Регистрация по приглашению'}</h2>
        {mode === 'register' && needsSetup && <p className="muted">Админов пока нет. Введите код установки, который выдал разработчик.</p>}
        <Field label="Логин или email">
          <input autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
        </Field>
        {mode === 'register' && (
          <Field label="Имя">
            <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
        )}
        <Field label="Пароль" hint={mode === 'register' ? 'минимум 8 символов' : undefined}>
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {mode === 'register' && (
          <Field label={needsSetup ? 'Код установки' : 'Код приглашения'}>
            <input value={invite} onChange={(e) => setInvite(e.target.value)} required />
          </Field>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy}>
          {mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
        </button>
        {!needsSetup && (
          <button type="button" className="link center" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Есть приглашение? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
          </button>
        )}
      </form>
    </div>
  );
}
