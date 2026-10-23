#!/bin/sh
# Резервная копия базы: копию делает само приложение (better-sqlite3), поэтому sqlite3 на сервере не нужен.
# Если контейнер app запущен, копия снимается внутри него; иначе — локальным node.
set -eu
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${ROOT_DIR}/backups"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TMP_NAME="backup-${TIMESTAMP}.tmp"
TARGET_FILE="${BACKUP_DIR}/app_${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"
cd "${ROOT_DIR}"

if command -v docker >/dev/null 2>&1 && [ -n "$(docker compose ps -q app 2>/dev/null)" ]; then
  # Копия пишется во временный файл в data/ (общий том), затем переносится в backups/
  docker compose exec -T app node scripts/backup-db.js "data/${TMP_NAME}"
else
  node scripts/backup-db.js "data/${TMP_NAME}"
fi

mv "data/${TMP_NAME}" "${TARGET_FILE}"
chmod 600 "${TARGET_FILE}"
echo "Резервная копия создана: ${TARGET_FILE}"

# Ротация: оставляем копии за последние 14 дней
find "${BACKUP_DIR}" -name "app_*.db" -type f -mtime +14 -delete
echo "Копии старше 14 дней удалены."
