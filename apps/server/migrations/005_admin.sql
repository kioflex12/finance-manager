-- админка: блокировка пользователей и время последнего обращения (для активности DAU/WAU)
ALTER TABLE users ADD COLUMN blocked boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX operations_created_idx ON operations (created_at);
