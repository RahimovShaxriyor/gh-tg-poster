#!/usr/bin/env bash
set -euo pipefail

# Чистый zip-архив для переноса на сервер (Linux / macOS): без зависимостей, базы, бэкапов, секретов и истории git
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NAME="$(basename "$ROOT_DIR")"
DEST="$ROOT_DIR/../$NAME.zip"

rm -f "$DEST"

cd "$ROOT_DIR/.."
zip -r "$DEST" "$NAME" \
  -x "$NAME/node_modules/*" \
  -x "$NAME/.git/*" \
  -x "$NAME/data/*" \
  -x "$NAME/backups/*" \
  -x "$NAME/screenshots/*" \
  -x "$NAME/.env" \
  -x "$NAME/*.zip"

echo "Архив создан: $DEST"
