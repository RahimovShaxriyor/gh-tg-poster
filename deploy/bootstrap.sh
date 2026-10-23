#!/bin/sh
# Подготовка чистого Ubuntu 24.04 (x86) под gh-tg-web. Запуск от root: sudo sh deploy/bootstrap.sh [параметры]
#
#   --ssh-from 203.0.113.7/32   SSH (порт 22) только с этого адреса; без параметра — ограничение частоты (ufw limit)
#   --deploy-user deploy        пользователь для приложения и обновлений (по умолчанию deploy)
#   --app-dir /opt/gh-tg-web    каталог приложения
#   --harden-ssh                второй этап: запретить вход по паролю и root по SSH.
#                               Запускайте ТОЛЬКО после того, как вошли по ключу пользователем deploy в другом окне.
#
# Скрипт можно запускать повторно: уже сделанные шаги пропускаются.
set -eu

log() { printf '[bootstrap] %s\n' "$*"; }
die() {
  printf '[bootstrap] ОШИБКА: %s\n' "$*" >&2
  exit 1
}

DEPLOY_USER=deploy
APP_DIR=/opt/gh-tg-web
SSH_FROM=""
HARDEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-from) SSH_FROM="${2:-}"; shift 2 ;;
    --deploy-user) DEPLOY_USER="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --harden-ssh) HARDEN=1; shift ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo."
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = "24.04" ] || die "Скрипт рассчитан на Ubuntu 24.04 (у вас ${PRETTY_NAME:-неизвестно})."

DEPLOY_HOME="/home/$DEPLOY_USER"
AUTH_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"

if [ "$HARDEN" = 1 ]; then
  [ -s "$AUTH_KEYS" ] || die "У $DEPLOY_USER нет ключей в $AUTH_KEYS: запрет входа по паролю отменён, иначе можно потерять доступ."
  cat >/etc/ssh/sshd_config.d/99-gh-tg-web.conf <<'CONF'
# gh-tg-web: вход только по ключу, root по SSH запрещён
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
  sshd -t || {
    rm -f /etc/ssh/sshd_config.d/99-gh-tg-web.conf
    die "Проверка конфигурации sshd не прошла: изменения отменены."
  }
  systemctl reload ssh
  log "Готово: вход по паролю и root по SSH запрещены. Не закрывайте текущее окно, пока не проверите вход в новом."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

log "Часовой пояс UTC"
timedatectl set-timezone UTC

log "Обновления системы"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -q ca-certificates curl gnupg git ufw fail2ban unattended-upgrades openssl sqlite3

log "Docker из официального репозитория"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null

log "Пользователь $DEPLOY_USER"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
# Группа docker равносильна root на этом сервере: пользователь deploy нужен только для приложения
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
if [ ! -s "$AUTH_KEYS" ] && [ -n "${SUDO_USER:-}" ] && [ -s "/home/$SUDO_USER/.ssh/authorized_keys" ]; then
  # Тот же ключ, с которым вы вошли как ubuntu
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$SUDO_USER/.ssh/authorized_keys" "$AUTH_KEYS"
  log "Ключ SSH скопирован от $SUDO_USER"
fi

log "Каталог приложения $APP_DIR"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

log "Swap для небольших инстансов"
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ] && [ "$mem_kb" -lt 2600000 ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo 'vm.swappiness=10' >/etc/sysctl.d/99-gh-tg-web-swap.conf
  sysctl -q -p /etc/sysctl.d/99-gh-tg-web-swap.conf
  log "Swap 1 ГБ включён"
fi

log "Брандмауэр UFW: 80 и 443 для всех, SSH — ${SSH_FROM:-с ограничением частоты}"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
if [ -n "$SSH_FROM" ]; then
  ufw allow from "$SSH_FROM" to any port 22 proto tcp >/dev/null
else
  ufw limit 22/tcp >/dev/null
fi
ufw --force enable >/dev/null

log "fail2ban для SSH"
cat >/etc/fail2ban/jail.d/gh-tg-web.local <<'CONF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
CONF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

log "Автоматические обновления безопасности"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
systemctl enable --now unattended-upgrades >/dev/null

log "Агент AWS SSM (нужен для выкладки из GitHub Actions без открытого SSH)"
if snap list amazon-ssm-agent >/dev/null 2>&1; then
  snap start --enable amazon-ssm-agent >/dev/null 2>&1 || true
  log "amazon-ssm-agent установлен"
else
  log "amazon-ssm-agent не найден: если нужен CI/CD через SSM, установите: sudo snap install amazon-ssm-agent --classic"
fi

log "Таймер ежедневной резервной копии"
for unit in gh-tg-backup.service gh-tg-backup.timer; do
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DEPLOY_USER@|$DEPLOY_USER|g" "$(dirname -- "$0")/systemd/$unit" >"/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now gh-tg-backup.timer >/dev/null

cat <<NEXT

Готово. Дальше:
  1. В НОВОМ окне проверьте вход по ключу: ssh $DEPLOY_USER@<адрес сервера>
  2. Если вход работает: sudo sh deploy/bootstrap.sh --harden-ssh
  3. Под пользователем $DEPLOY_USER: клонируйте репозиторий в $APP_DIR, создайте .env и deploy/deploy.env,
     затем sh deploy/deploy.sh (подробно — docs/aws-deploy.md).
NEXT
