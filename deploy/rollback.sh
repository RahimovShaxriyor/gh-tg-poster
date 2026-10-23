#!/bin/sh
# Возврат к предыдущей версии (образ gh-tg-web:previous и коммит из .deploy/previous_sha).
#   deploy/rollback.sh             только код и образ; база остаётся текущей
#   deploy/rollback.sh --with-db   ещё и база из последней копии перед обновлением (backups/predeploy)
#   --yes                          без вопроса (для автоматизации)
# Изменения базы обычно совместимы назад (новые колонки и таблицы старая версия просто не читает),
# поэтому базу возвращают, только если новая версия успела испортить данные.
set -eu
# Обычные права для файлов кода из git (иначе образ получит нечитаемые файлы); копии базы
# backup.sh и restore.sh создают со своим umask 077
umask 022

. "$(dirname -- "$0")/lib.sh"

# Всё тело — в функции: оболочка разбирает её целиком до запуска. Иначе git, обновляя этот же файл
# посреди выполнения, подменил бы ещё не прочитанные строки скрипта.
main() {
  load_config
  cd "$APP_DIR"

  WITH_DB=0
  for arg in "$@"; do
    case "$arg" in
      --with-db) WITH_DB=1 ;;
      --yes) ASSUME_YES=1 ;;
      *) die "Неизвестный параметр: $arg" ;;
    esac
  done

  [ -f "$STATE_DIR/previous_sha" ] || die "Нет сведений о предыдущей версии (.deploy/previous_sha): откатываться не на что."
  docker image inspect gh-tg-web:previous >/dev/null 2>&1 || die "Нет образа gh-tg-web:previous: откатываться не на что."
  PREV_SHA="$(cat "$STATE_DIR/previous_sha")"
  CUR_SHA="$(git rev-parse HEAD)"
  DB_COPY=""
  if [ "$WITH_DB" = 1 ]; then
    DB_COPY="$(ls -1t "$APP_DIR"/backups/predeploy/app_*.db 2>/dev/null | head -n 1 || true)"
    [ -n "$DB_COPY" ] || die "Нет копий в backups/predeploy: базу вернуть не из чего."
  fi

  confirm "Откат с $(printf '%s' "$CUR_SHA" | cut -c1-7) на $(printf '%s' "$PREV_SHA" | cut -c1-7)${DB_COPY:+ и база из $(basename "$DB_COPY")}."

  if [ -n "$DB_COPY" ]; then
    ASSUME_YES=1 sh "$APP_DIR/deploy/restore.sh" "$DB_COPY" --yes
  fi

  acquire_lock
  git diff --quiet && git diff --cached --quiet || die "Есть правки отслеживаемых файлов (git status): откат отменён."
  git reset --hard --quiet "$PREV_SHA"
  docker tag gh-tg-web:previous gh-tg-web:current
  compose up -d --no-build >/dev/null
  wait_healthy "${HEALTH_TIMEOUT:-120}" || die "Прежняя версия не стала healthy. Логи: docker compose logs app"
  printf '%s\n' "$PREV_SHA" >"$STATE_DIR/current_sha"
  rm -f "$STATE_DIR/previous_sha"
  log "Откат выполнен: работает $(git rev-parse --short HEAD). Следующий deploy.sh снова обновит до origin/${DEPLOY_BRANCH:-master}."
}

main "$@"
exit $?
