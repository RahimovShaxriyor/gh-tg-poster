# Версия Node зафиксирована: обновляйте её осознанно и прогоняйте тесты.
# better-sqlite3 13 содержит готовые сборки (prebuilds/linux-x64.node, linux-arm64.node) на Node-API,
# поэтому компилятор в образе не нужен, а install-скрипт (node-gyp rebuild) отключён флагом --ignore-scripts.
FROM node:24.22.1-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY lib ./lib
COPY public ./public
COPY scripts/backup-db.js scripts/check-db.js scripts/reset-password.js ./scripts/
COPY server.js .env.example ./

# Версия для /health в боте: deploy.sh передаёт короткий sha коммита
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Код только для чтения всем, независимо от прав файлов на диске сервера (umask при git pull)
RUN chmod -R u=rwX,go=rX lib public scripts server.js .env.example package.json

# Приложение работает от пользователя node (uid 1000), а не от root. Пишет только в /app/data
# (том с хоста) и во временную папку, поэтому в compose корень контейнера — только для чтения.
RUN mkdir -p data && chown node:node data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
