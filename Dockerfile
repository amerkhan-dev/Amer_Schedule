# Amer OS: the planner page and its API in one container.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

# Keep the database on a mounted volume so it survives redeploys.
ENV DB_FILE=/data/amer.db
VOLUME /data

EXPOSE 3000
CMD ["node", "server/index.mjs"]
