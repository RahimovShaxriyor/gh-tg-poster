#!/usr/bin/env bash
set -euo pipefail

# Скрипт сборки чистого zip-архива для деплоя на сервер (Linux / macOS)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$ROOT_DIR/../gh-tg-web.zip"

rm -f "$DEST"

cd "$ROOT_DIR/.."
zip -r "$DEST" gh-tg-web \
  -x "gh-tg-web/node_modules/*" \
  -x "gh-tg-web/data/*.db*" \
  -x "gh-tg-web/.env" \
  -x "gh-tg-web/*.zip"

echo "Архив успешно создан: $DEST"
