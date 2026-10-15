# Развёртывание

Сейчас приложение работает на VPS с 512 МБ памяти и 5 ГБ диска, поэтому без Docker:
Node.js, Postgres и Caddy стоят прямо в системе. Для сервера покрупнее подойдёт
`docker-compose.yml` из корня репозитория.

## Текущий сервер

- Ubuntu 24.04, KVM, адрес `185.246.118.148`, вход только по SSH-ключу.
- Миниапп: https://185-246-118-148.sslip.io — имя от sslip.io указывает на IP сервера,
  сертификат Let's Encrypt Caddy получает и продлевает сам.
- Админка: https://admin.185-246-118-148.sslip.io — отдельный сайт (`apps/admin`), Caddy отдаёт его статику,
  а `/api/admin/*` проксирует в приложение. На адресе миниаппа `/api/admin` закрыт.
  Вход — единственные логин и пароль из `.env` (`ADMIN_LOGIN`, `ADMIN_PASSWORD`), регистрации нет.
  Смена пароля — правкой `.env` и `systemctl restart finance-manager`; старые сессии при этом перестают действовать.
- Приложение: `/opt/finance-manager`, пользователь `fm`, сервис `finance-manager` (systemd).
- Настройки: `/opt/finance-manager/.env` (токен бота, ключ LLM, `DATABASE_URL`).
- База: Postgres 16, база и роль `fm`; настройки под малую память — `/etc/postgresql/16/main/conf.d/small.conf`.
- HTTPS: `/etc/caddy/Caddyfile`, файрвол ufw открывает 22, 80, 443.

**Telegram у этого хостера.** Основной адрес `api.telegram.org` из сети хостера недоступен,
поэтому в `/etc/hosts` он закреплён за рабочим адресом Telegram `149.154.167.220`.
Если бот перестанет отвечать, первым делом проверить:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.telegram.org/bot0/getMe   # ожидается 404
```

## Обслуживание и сбои

- Диск маленький (5 ГБ): заголовки ядра и snapd удалены, журналы ограничены 30 МБ
  (`/etc/systemd/journald.conf.d/size.conf`), автообновления сами удаляют старые ядра и
  перезагружают сервер в 04:30, если обновление ядра этого требует (`/etc/apt/apt.conf.d/52finance-manager`).
- Postgres перезапускается сам после сбоя (`/etc/systemd/system/postgresql@.service.d/restart.conf`).
  Так было 15.10.2026: ночное обновление пакетов забило диск, Postgres упал и не поднялся.
- Оповещения: бот пишет на `ALERT_TG_ID`, если свободного места меньше 400 МБ, база не открывается
  или падают фоновые задачи (одно и то же — не чаще раза в 6 часов).

## Обновление

```bash
scripts/deploy.sh            # сборка, загрузка, npm ci, перезапуск сервиса
```

## Полезное

```bash
journalctl -u finance-manager -f          # логи
systemctl restart finance-manager         # перезапуск
sudo -u postgres psql fm                  # база
```

## Первичная настройка нового сервера

1. `apt install postgresql caddy ufw`, Node.js 24 из официального архива в `/usr/local`.
2. Роль и база `fm` в Postgres, `small.conf` с уменьшенными буферами.
3. Пользователь `fm`, каталог `/opt/finance-manager`, `.env` по образцу `.env.example`
   плюс `DATABASE_URL`, `WEBAPP_URL=https://<ip-через-дефисы>.sslip.io`.
4. Unit `finance-manager.service`: `node --max-old-space-size=192 apps/server/dist/index.js`
   от пользователя `fm`, `Restart=always`.
5. Caddyfile: сайт миниаппа — `encode gzip` для всего, кроме потока событий `*/events`, `reverse_proxy localhost:3000`,
   `/api/admin/*` → 404; сайт `admin.<домен>` — `/api/admin/*` в приложение, остальное — `apps/admin/dist`
   с `try_files {path} /index.html`. Плюс `ADMIN_LOGIN` и `ADMIN_PASSWORD` в `.env` для входа в админку.
6. `scripts/deploy.sh root@<ip>`.
