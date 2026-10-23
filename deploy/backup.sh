#!/bin/sh
# Резервная копия базы.
#   deploy/backup.sh               ежедневная копия: зашифрованная, хранится BACKUP_KEEP_DAYS дней, по желанию — в S3
#   deploy/backup.sh --pre-deploy  копия перед обновлением: без шифрования, в backups/predeploy (последние 5)
#
# Копия консистентная: её снимает SQLite online backup API (то же, что команда .backup в sqlite3)
# внутри контейнера приложения, с проверкой integrity_check. Простое копирование файла не используется:
# база в режиме WAL, и копия могла бы оказаться несогласованной.
set -eu
umask 077

. "$(dirname -- "$0")/lib.sh"
load_config

MODE=daily
[ "${1:-}" = "--pre-deploy" ] && MODE=predeploy

BACKUP_DIR="$APP_DIR/backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
TS="$(date -u +%Y%m%d_%H%M%S)"
TMP_REL="data/.backup-$TS.db"
TMP="$APP_DIR/$TMP_REL"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR/predeploy"
[ -f "$APP_DIR/data/app.db" ] || die "База $APP_DIR/data/app.db не найдена: копировать нечего."
trap 'rm -f "$TMP" "$TMP-wal" "$TMP-shm"' EXIT INT TERM

if app_running; then
  compose exec -T app node scripts/backup-db.js "$TMP_REL" >/dev/null
elif command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$APP_DIR/data/app.db" ".backup '$TMP'"
  [ "$(sqlite3 "$TMP" 'PRAGMA integrity_check;')" = ok ] || die "Копия не прошла integrity_check."
elif command -v node >/dev/null 2>&1 && [ -d "$APP_DIR/node_modules/better-sqlite3" ]; then
  (cd "$APP_DIR" && node scripts/backup-db.js "$TMP_REL" >/dev/null)
else
  die "Контейнер app не запущен, а sqlite3 не установлен: запустите приложение (docker compose up -d) или установите sqlite3."
fi
chmod 600 "$TMP"

if [ "$MODE" = predeploy ]; then
  sha="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  OUT="$BACKUP_DIR/predeploy/app_${TS}_${sha}.db"
  mv "$TMP" "$OUT"
  # Оставляем 5 последних копий перед обновлением
  ls -1t "$BACKUP_DIR"/predeploy/app_*.db 2>/dev/null | tail -n +6 | while IFS= read -r old; do rm -f "$old"; done
  log "Копия перед обновлением: $OUT" | tee -a "$LOG"
  exit 0
fi

ENCRYPTED=true
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || die "Задан BACKUP_AGE_RECIPIENT, но age не установлен: sudo apt-get install -y age"
  OUT="$BACKUP_DIR/app_$TS.db.age"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT" "$TMP"
elif [ -n "${BACKUP_CERT:-}" ]; then
  [ -f "$BACKUP_CERT" ] || die "Сертификат для шифрования не найден: $BACKUP_CERT"
  OUT="$BACKUP_DIR/app_$TS.db.cms"
  openssl cms -encrypt -binary -aes-256-cbc -outform DER -in "$TMP" -out "$OUT" "$BACKUP_CERT"
elif [ "${BACKUP_ENCRYPT:-1}" = 0 ]; then
  warn "Копия без шифрования (BACKUP_ENCRYPT=0)."
  ENCRYPTED=false
  OUT="$BACKUP_DIR/app_$TS.db"
  cp "$TMP" "$OUT"
else
  die "Не задан ключ шифрования копий: BACKUP_CERT или BACKUP_AGE_RECIPIENT в deploy/deploy.env (или явно BACKUP_ENCRYPT=0)."
fi
chmod 600 "$OUT"
rm -f "$TMP"

UPLOADED=false
if [ -n "${S3_BUCKET:-}" ]; then
  command -v aws >/dev/null 2>&1 || die "Задан S3_BUCKET, но AWS CLI не установлен: sudo snap install aws-cli --classic"
  aws s3 cp "$OUT" "s3://$S3_BUCKET/${S3_PREFIX:-gh-tg-web}/$(basename "$OUT")" --only-show-errors
  UPLOADED=true
fi

# Ротация локальных ежедневных копий
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'app_*' -mtime +"$KEEP_DAYS" -exec rm -f {} +

# Отметка для /backup и /health в боте
SIZE="$(wc -c <"$OUT" | tr -d ' ')"
printf '{"at":"%s","file":"%s","size":%s,"encrypted":%s,"uploaded":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$OUT")" "$SIZE" "$ENCRYPTED" "$UPLOADED" >"$APP_DIR/data/.last-backup.tmp"
mv "$APP_DIR/data/.last-backup.tmp" "$APP_DIR/data/last-backup.json"

log "Резервная копия: $OUT ($SIZE байт, зашифрована: $ENCRYPTED, в S3: $UPLOADED)" | tee -a "$LOG"
