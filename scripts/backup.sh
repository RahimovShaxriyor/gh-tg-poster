#!/bin/sh
# Оставлено для совместимости: резервная копия теперь в deploy/backup.sh
exec sh "$(dirname -- "$0")/../deploy/backup.sh" "$@"
