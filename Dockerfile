# Версия Node зафиксирована: обновляйте её осознанно и прогоняйте тесты
FROM node:24.22.1-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 поставляется с готовыми сборками (prebuilds), компилятор не нужен:
# install-скрипт (node-gyp rebuild) отключён флагом --ignore-scripts
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY lib ./lib
COPY public ./public
COPY scripts/backup-db.js scripts/reset-password.js ./scripts/
COPY server.js .env.example ./

# Приложение работает от пользователя node (uid 1000), а не от root
RUN mkdir -p data && chown node:node data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
