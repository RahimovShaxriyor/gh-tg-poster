#!/bin/sh
# Восстановление базы из копии.
#   deploy/restore.sh <файл> [--key <закрытый ключ>] [--yes]
# Файл: .db (без шифрования), .db.cms (OpenSSL, нужен --key с закрытым ключом), .db.age (age, --key с identity).
# Перед заменой: расшифровка, проверка PRAGMA integrity_check, подтверждение и копия текущей базы.
set -eu
umask 077

. "$(dirname -- "$0")/lib.sh"
load_config

FILE=""
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -*) die "Неизвестный параметр: $1" ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] || die "Использование: deploy/restore.sh <файл копии> [--key <ключ>] [--yes]"
[ -f "$FILE" ] || die "Файл не найден: $FILE"

acquire_lock
TS="$(date -u +%Y%m%d_%H%M%S)"
CANDIDATE_REL="data/.restore-$TS.db"
CANDIDATE="$APP_DIR/$CANDIDATE_REL"
trap 'rm -f "$CANDIDATE"; rmdir "$STATE_DIR/lock" 2>/dev/null || true' EXIT INT TERM

case "$FILE" in
  *.cms)
    [ -n "$KEY" ] || die "Копия зашифрована: укажите --key <закрытый ключ backup-key.pem>. Ключ храните не на сервере, после восстановления удалите его копию."
    openssl cms -decrypt -binary -inform DER -in "$FILE" -inkey "$KEY" -out "$CANDIDATE" || die "Не удалось расшифровать: неверный ключ или повреждённый файл."
    ;;
  *.age)
    [ -n "$KEY" ] || die "Копия зашифрована age: укажите --key <файл identity>."
    age -d -i "$KEY" -o "$CANDIDATE" "$FILE" || die "Не удалось расшифровать копию age."
    ;;
  *) cp "$FILE" "$CANDIDATE" ;;
esac
chmod 600 "$CANDIDATE"

log "Проверяю копию (PRAGMA integrity_check)…"
if docker image inspect gh-tg-web:current >/dev/null 2>&1; then
  compose run --rm --no-deps -T app node scripts/check-db.js "$CANDIDATE_REL" || die "Копия не прошла проверку: база не заменена."
elif command -v sqlite3 >/dev/null 2>&1; then
  [ "$(sqlite3 "$CANDIDATE" 'PRAGMA integrity_check;')" = ok ] || die "Копия не прошла integrity_check: база не заменена."
  log "integrity_check: ok"
else
  (cd "$APP_DIR" && node scripts/check-db.js "$CANDIDATE_REL") || die "Копия не прошла проверку: база не заменена."
fi

confirm "Текущая база $APP_DIR/data/app.db будет заменена копией $(basename "$FILE"). Перед этим снимется копия текущей базы."

if [ -f "$APP_DIR/data/app.db" ]; then
  sh "$APP_DIR/deploy/backup.sh" --pre-deploy || die "Не удалось сохранить текущую базу: восстановление отменено."
fi

log "Останавливаю приложение…"
compose stop app >/dev/null 2>&1 || true
rm -f "$APP_DIR/data/app.db-wal" "$APP_DIR/data/app.db-shm"
mv "$CANDIDATE" "$APP_DIR/data/app.db"
chmod 600 "$APP_DIR/data/app.db"

if docker image inspect gh-tg-web:current >/dev/null 2>&1; then
  compose up -d app >/dev/null
  wait_healthy "${HEALTH_TIMEOUT:-120}" || die "После восстановления приложение не стало healthy. Прежняя база — в backups/predeploy/ (последний файл). Логи: docker compose logs app"
fi
log "База восстановлена из $(basename "$FILE"). Если ENCRYPTION_KEY в .env не тот, что был при создании копии, токены и ключи придётся ввести в панели заново."
