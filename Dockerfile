FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev || (apt-get update && apt-get install -y python3 make g++ && npm install --omit=dev)
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]
