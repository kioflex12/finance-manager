-- Позицию, которую пользователь исправил сам, автоматическая группировка больше не трогает.
ALTER TABLE operations ADD COLUMN item_locked boolean NOT NULL DEFAULT false;
