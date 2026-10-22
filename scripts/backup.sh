#!/bin/sh
set -eu

# Определение рабочей директории проекта
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DATA_FILE="${ROOT_DIR}/data/app.db"
BACKUP_DIR="${ROOT_DIR}/backups"

mkdir -p "${BACKUP_DIR}"

if [ ! -f "${DATA_FILE}" ]; then
  echo "Ошибка: База данных не найдена по пути ${DATA_FILE}"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_FILE="${BACKUP_DIR}/app_${TIMESTAMP}.db"

# Создание копии: если установлен sqlite3, выполняем безопасный онлайн-бэкап без блокировки
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DATA_FILE}" ".backup '${TARGET_FILE}'"
else
  cp "${DATA_FILE}" "${TARGET_FILE}"
fi

echo "Резервная копия успешно создана: ${TARGET_FILE}"

# Ротация старых копий: оставляем копии за последние 14 дней
find "${BACKUP_DIR}" -name "app_*.db" -type f -mtime +14 -delete 2>/dev/null || true
echo "Старые копии (старше 14 дней) удалены."
