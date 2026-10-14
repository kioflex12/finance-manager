#!/usr/bin/env bash
# Выкладка на VPS без Docker: сборка локально, на сервер едут только собранные файлы.
# Первичная настройка сервера (Node, Postgres, Caddy, systemd) описана в deploy/README.md.
# Использование: scripts/deploy.sh [root@host]
set -euo pipefail

HOST="${1:-root@185.246.118.148}"
APP_DIR=/opt/finance-manager
ARCHIVE="$(mktemp -d)/release.tgz"

cd "$(dirname "$0")/.."
npm run build
tar --force-local -czf "$ARCHIVE" package.json package-lock.json \
  apps/server/package.json apps/server/dist apps/server/migrations \
  apps/miniapp/package.json apps/miniapp/dist \
  apps/admin/package.json apps/admin/dist

scp -q "$ARCHIVE" "$HOST:/tmp/release.tgz"
ssh "$HOST" "set -e
  cd $APP_DIR
  rm -rf apps/server/dist apps/miniapp/dist apps/admin/dist
  tar -xzf /tmp/release.tgz && rm /tmp/release.tgz
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  npm cache clean --force 2>/dev/null
  chown -R fm:fm $APP_DIR
  systemctl restart finance-manager
  sleep 8
  systemctl is-active finance-manager
  journalctl -u finance-manager -n 5 --no-pager -o cat"
