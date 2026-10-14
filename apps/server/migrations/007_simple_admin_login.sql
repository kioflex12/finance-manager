-- вход в админку упрощён до одного логина и пароля из настроек сервера:
-- учётные записи, сессии и приглашения в базе больше не нужны, журнал действий остаётся
DROP TABLE admin_invites;
DROP TABLE admin_sessions;
ALTER TABLE admin_audit DROP COLUMN admin_id;
DROP TABLE admins;
