#!/bin/sh
# Случайные значения для .env. Печатаются ОДИН раз и нигде не сохраняются: скопируйте их сразу.
set -eu
command -v openssl >/dev/null 2>&1 || { echo "Нужен openssl" >&2; exit 1; }

pass="$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-28)"
cat <<OUT
# Вставьте в .env на сервере (chmod 600 .env). Повторный запуск даст другие значения.
ADMIN_PASSWORD=$pass
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# ВАЖНО: сохраните ENCRYPTION_KEY отдельно (в менеджере паролей).
# Без него токены и ключи в базе не расшифровать: после потери ключа их придётся ввести заново,
# а копии базы с сервера восстановятся без секретов.
OUT
