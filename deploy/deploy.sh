#!/bin/sh
# Обновление на сервере: код из git (только fast-forward), копия базы, сборка образа, запуск, проверка /health.
# Если новая версия не стала healthy — автоматический откат на прежний образ и прежний коммит.
#   deploy/deploy.sh            обновиться до origin/<DEPLOY_BRANCH>
#   deploy/deploy.sh <sha>      обновиться ровно до этого коммита (так делает CI/CD: проверенный коммит)
#   FORCE=1 deploy/deploy.sh    пересобрать, даже если обновлений нет
#
# Личные данные не трогаются: .env, data/, backups/, deploy/deploy.env, том caddy_data не входят в git
# (git меняет только отслеживаемые файлы), а контейнеры пересоздаются с теми же томами.
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

  BRANCH="${DEPLOY_BRANCH:-main}"
  TARGET="${1:-}"
  require_env_file
  acquire_lock

  git diff --quiet && git diff --cached --quiet || die "В рабочей копии на сервере есть правки отслеживаемых файлов (git status). Обновление отменено, чтобы их не потерять."

  PREV_SHA="$(git rev-parse HEAD)"
  log "Получаю обновления из origin/${BRANCH}…"
  git fetch --quiet origin "$BRANCH" || die "git fetch не удался: проверьте deploy key или токен (docs/aws-deploy.md, раздел «Доступ к репозиторию»)."
  if [ -n "$TARGET" ]; then
    git merge-base --is-ancestor "$TARGET" "origin/$BRANCH" || die "Коммит $TARGET не входит в origin/$BRANCH: обновление отменено."
  else
    TARGET="$(git rev-parse "origin/$BRANCH")"
  fi
  TARGET="$(git rev-parse "$TARGET")"

  # Обновлять нечего, только если версия та же и приложение работает (после сбоя — запускаем заново)
  if [ "$TARGET" = "$PREV_SHA" ] && docker image inspect gh-tg-web:current >/dev/null 2>&1 && [ "$(app_health)" = healthy ] && [ "${FORCE:-0}" != 1 ]; then
    log "Уже последняя версия ($(git rev-parse --short HEAD)). Обновлять нечего."
    exit 0
  fi

  # Внешние образы (Caddy) скачиваем до любых изменений: сбой сети не должен оставить сервер без работающей версии
  log "Скачиваю внешние образы…"
  compose pull --quiet --ignore-buildable || die "Не удалось скачать образы (сеть или Docker Hub). Ничего не изменено, работает прежняя версия."

  if [ -f "$APP_DIR/data/app.db" ]; then
    log "Копия базы перед обновлением…"
    sh "$APP_DIR/deploy/backup.sh" --pre-deploy
  fi

  git merge --ff-only --quiet "$TARGET" || die "Не удалось обновиться fast-forward до $TARGET (история разошлась). Ничего не изменено."
  NEW_SHORT="$(git rev-parse HEAD | cut -c1-7)"

  # Сведения для отката: прежние значения возвращаются, если это обновление не удастся
  OLD_PREV_SHA="$(cat "$STATE_DIR/previous_sha" 2>/dev/null || true)"
  HAD_IMAGE=0
  if docker image inspect gh-tg-web:current >/dev/null 2>&1; then
    docker tag gh-tg-web:current gh-tg-web:previous
    HAD_IMAGE=1
  fi
  printf '%s\n' "$PREV_SHA" >"$STATE_DIR/previous_sha"

  restore_rollback_point() {
    if [ -n "$OLD_PREV_SHA" ] && docker image inspect "gh-tg-web:sha-$(printf '%s' "$OLD_PREV_SHA" | cut -c1-7)" >/dev/null 2>&1; then
      docker tag "gh-tg-web:sha-$(printf '%s' "$OLD_PREV_SHA" | cut -c1-7)" gh-tg-web:previous
      printf '%s\n' "$OLD_PREV_SHA" >"$STATE_DIR/previous_sha"
    else
      rm -f "$STATE_DIR/previous_sha"
    fi
  }

  rollback() {
    warn "$1 Откатываюсь на $(printf '%s' "$PREV_SHA" | cut -c1-7)."
    git reset --hard --quiet "$PREV_SHA"
    if [ "$HAD_IMAGE" = 1 ]; then
      docker tag gh-tg-web:previous gh-tg-web:current
      restore_rollback_point
      compose up -d --no-build >/dev/null 2>&1 || true
      if wait_healthy "${HEALTH_TIMEOUT:-120}"; then
        die "Обновление до $NEW_SHORT не удалось, прежняя версия работает. Логи новой версии: docker compose logs app"
      fi
      die "Обновление не удалось, и прежняя версия тоже не поднялась. Проверьте: docker compose logs app; deploy/check.sh"
    fi
    die "Первый запуск не удался. Проверьте: docker compose logs app"
  }

  log "Собираю образ ${NEW_SHORT}…"
  APP_VERSION="$NEW_SHORT" compose build app || rollback "Сборка не удалась."
  log "Запускаю…"
  compose up -d --remove-orphans || rollback "docker compose up не удался."
  if ! wait_healthy "${HEALTH_TIMEOUT:-120}"; then
    rollback "Новая версия не прошла проверку /health за ${HEALTH_TIMEOUT:-120} с."
  fi

  printf '%s\n' "$(git rev-parse HEAD)" >"$STATE_DIR/current_sha"
  # Постоянный тег по коммиту: по нему откатываются и после нескольких обновлений подряд
  docker tag gh-tg-web:current "gh-tg-web:sha-$NEW_SHORT"
  # Храним образы трёх последних версий, остальные теги удаляем
  docker image ls gh-tg-web --format '{{.Tag}}' | grep '^sha-' | while IFS= read -r tag; do
    created="$(docker image inspect -f '{{.Created}}' "gh-tg-web:$tag")"
    printf '%s %s\n' "$created" "$tag"
  done | sort -r | tail -n +4 | while IFS=' ' read -r _ tag; do docker rmi "gh-tg-web:$tag" >/dev/null 2>&1 || true; done
  docker image prune -f --filter "dangling=true" >/dev/null 2>&1 || true
  log "Готово: работает версия $NEW_SHORT. Откат при необходимости: deploy/rollback.sh"
}

main "$@"
exit $?
