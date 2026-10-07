# ---- build the web client ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY web web
RUN npm -w web run build

# ---- runtime (server runs TypeScript natively on Node 24, no build step) ----
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    WEB_DIST=/app/web/dist
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY shared shared
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
# /data holds the database and uploads: mount a volume there (docker compose and the Railway template do).
# No VOLUME instruction on purpose – some hosts (e.g. Railway) reject it and manage volumes themselves.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
