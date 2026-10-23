# shellcheck shell=sh
# Общие функции скриптов deploy/. Подключается через `. deploy/lib.sh`.
# Личные данные (.env, data/, backups/, том caddy_data) скрипты только читают и копируют,
# кроме restore.sh, который по подтверждению заменяет базу.

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { log "ВНИМАНИЕ: $*" >&2; }
die() {
  log "ОШИБКА: $*" >&2
  exit 1
}

# Корень проекта: каталог выше deploy/
APP_DIR="${APP_DIR:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"
STATE_DIR="$APP_DIR/.deploy"

# Настройки скриптов (не секреты приложения): deploy/deploy.env, его нет в git
load_config() {
  if [ -f "$APP_DIR/deploy/deploy.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$APP_DIR/deploy/deploy.env"
    set +a
  fi
}

compose() { docker compose --project-directory "$APP_DIR" "$@"; }

app_container() { compose ps -q app 2>/dev/null || true; }
app_running() { [ -n "$(compose ps -q --status running app 2>/dev/null || true)" ]; }

app_health() {
  cid="$(app_container)"
  [ -n "$cid" ] || {
    echo none
    return 0
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo none
}

# Ждём статуса healthy у контейнера app (по HEALTHCHECK, который ходит в /health)
wait_healthy() {
  limit="${1:-120}"
  waited=0
  while [ "$waited" -lt "$limit" ]; do
    status="$(app_health)"
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && return 1
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# Значение одной переменной из .env без вывода остальных (секреты не печатаются)
env_value() {
  [ -f "$APP_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -n 1
}

require_env_file() {
  [ -f "$APP_DIR/.env" ] || die "Нет файла $APP_DIR/.env. Создайте его по образцу .env.production.example (права 600)."
  perms="$(ls -l "$APP_DIR/.env" | cut -c1-10)"
  case "$perms" in
    -rw-------) ;;
    *) warn ".env доступен не только владельцу ($perms). Выполните: chmod 600 $APP_DIR/.env" ;;
  esac
}

# Один запуск за раз: deploy, rollback и restore не должны идти параллельно
acquire_lock() {
  mkdir -p "$STATE_DIR"
  if ! mkdir "$STATE_DIR/lock" 2>/dev/null; then
    die "Уже идёт другое обновление или восстановление ($STATE_DIR/lock). Если это не так, удалите папку lock."
  fi
  trap 'rmdir "$STATE_DIR/lock" 2>/dev/null || true' EXIT INT TERM
}

confirm() {
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  printf '%s Введите yes, чтобы продолжить: ' "$1"
  read -r answer || answer=""
  [ "$answer" = yes ] || die "Отменено."
}
