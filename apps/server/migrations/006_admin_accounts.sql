-- учётные записи сайта-админки: вход по логину и паролю, сессии, приглашения и журнал действий
CREATE TABLE admins (
  id serial PRIMARY KEY,
  login text NOT NULL UNIQUE,
  name text NOT NULL,
  -- scrypt: соль и хэш, сам пароль не хранится
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE admin_sessions (
  -- sha256 от токена из cookie: утечка базы не даёт готовых сессий
  token_hash text PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);

CREATE TABLE admin_invites (
  code_hash text PRIMARY KEY,
  created_by integer REFERENCES admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_by integer REFERENCES admins(id) ON DELETE SET NULL,
  used_at timestamptz
);

CREATE TABLE admin_audit (
  id serial PRIMARY KEY,
  admin_id integer REFERENCES admins(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);
