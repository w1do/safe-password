# syntax=docker/dockerfile:1

# ---------- build: compile the panel and the server ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# ---------- deps: production dependencies of the server only ----------
FROM build AS deps
RUN rm -rf node_modules server/node_modules web/node_modules \
 && npm ci --omit=dev --workspace server --include-workspace-root=false

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8089 \
    HOST=0.0.0.0 \
    VAULT_DATA_DIR=/data \
    VAULT_WEB_DIR=/app/public
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./public
# Named volumes inherit this ownership and mode on first creation.
RUN mkdir -p /data/db /data/config && chown -R node:node /data && chmod 700 /data/db /data/config
USER node
EXPOSE 8089
VOLUME ["/data/db", "/data/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8089/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
