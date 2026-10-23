#!/bin/sh
# Быстрая диагностика сервера: диск, память, контейнеры, /health, сертификат, последняя копия.
# Секреты из .env не печатаются (читается только DOMAIN).
# Без -e намеренно: диагностика проверяет всё до конца и в итоге сообщает число проблем
set -u

. "$(dirname -- "$0")/lib.sh"
load_config
cd "$APP_DIR" || exit 1
problems=0
bad() {
  printf '  ✗ %s\n' "$*"
  problems=$((problems + 1))
}
ok() { printf '  ✓ %s\n' "$*"; }

echo "Диск:"
df -h "$APP_DIR" | tail -n 1 | awk '{print "  " $5 " занято, свободно " $4}'
use="$(df -P "$APP_DIR" | tail -n 1 | awk '{gsub("%","",$5); print $5}')"
[ "$use" -lt 85 ] || bad "диск заполнен больше чем на 85%"

echo "Память:"
if command -v free >/dev/null 2>&1; then free -m | awk 'NR==2{print "  свободно " $7 " МБ из " $2 " МБ"} NR==3{print "  swap: " $2 " МБ"}'; fi

echo "Контейнеры:"
compose ps --format '  {{.Service}}: {{.State}} {{.Status}}' 2>/dev/null || bad "docker compose недоступен"
health="$(app_health)"
[ "$health" = healthy ] && ok "app: healthy" || bad "app: $health (docker compose logs app)"

echo "Версия:"
printf '  %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo неизвестно)"

DOMAIN="$(env_value DOMAIN)"
echo "HTTPS ($DOMAIN):"
if [ -n "$DOMAIN" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then ok "https://$DOMAIN/health отвечает"; else bad "https://$DOMAIN/health не отвечает"; fi
  end="$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -n "$end" ]; then ok "сертификат действует до $end"; else bad "сертификат не получен (DNS, порты 80/443, логи: docker compose logs caddy)"; fi
else
  bad "DOMAIN не задан в .env или нет curl"
fi

echo "Резервная копия:"
if [ -f "$APP_DIR/data/last-backup.json" ]; then
  ok "$(cat "$APP_DIR/data/last-backup.json")"
  if [ -n "$(find "$APP_DIR/data/last-backup.json" -mmin +1560 2>/dev/null)" ]; then bad "последняя копия старше 26 часов (systemctl status gh-tg-backup.timer)"; fi
else
  bad "копий ещё не было (sh deploy/backup.sh)"
fi

echo
if [ "$problems" -eq 0 ]; then echo "Всё в порядке."; else echo "Проблем: $problems"; fi
[ "$problems" -eq 0 ]
