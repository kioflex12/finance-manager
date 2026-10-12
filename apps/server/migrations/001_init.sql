CREATE TABLE users (
  id serial PRIMARY KEY,
  tg_id text NOT NULL UNIQUE,
  name text NOT NULL,
  active_room_id integer,
  reminders boolean NOT NULL DEFAULT true,
  last_reminded_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id serial PRIMARY KEY,
  name text NOT NULL,
  owner_id integer NOT NULL REFERENCES users(id),
  -- групповой чат, к которому привязана комната (сводки уходят туда)
  tg_chat_id text UNIQUE,
  period_kind text NOT NULL CHECK (period_kind IN ('month', 'days')),
  period_days integer NOT NULL DEFAULT 30,
  auto_renew boolean NOT NULL DEFAULT true,
  -- бюджет на период в копейках
  budget integer,
  invite_code text NOT NULL UNIQUE,
  tz_offset_min integer NOT NULL DEFAULT 180,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_members (
  room_id integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE periods (
  id serial PRIMARY KEY,
  room_id integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  closed_at timestamptz
);
CREATE INDEX periods_open_idx ON periods (ends_at) WHERE closed_at IS NULL;

CREATE TABLE categories (
  id serial PRIMARY KEY,
  room_id integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  emoji text NOT NULL,
  UNIQUE (room_id, name)
);

CREATE TABLE operations (
  id serial PRIMARY KEY,
  room_id integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  period_id integer NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id),
  -- сумма в копейках
  amount integer NOT NULL CHECK (amount > 0),
  description text NOT NULL,
  category_id integer REFERENCES categories(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_period_idx ON operations (period_id);

-- выученные соответствия «описание → категория»; проверяются до LLM
CREATE TABLE rules (
  room_id integer NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  key text NOT NULL,
  category_id integer NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  -- правило от пользователя не перезаписывается догадкой LLM
  by_user boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, key)
);
