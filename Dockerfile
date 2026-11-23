# syntax=docker/dockerfile:1
# Outpost: one container, one port (docs/PLAN.md §0.2, §11).
#   docker compose build && docker compose up -d
# The server runs TypeScript directly with Node's type stripping; only the web app is built.

FROM node:26-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Workspace manifests only, so dependency layers are cached until they change.
FROM base AS manifests
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/

# --- Build the web app (needs every dev dependency) --------------------------
FROM manifests AS build
RUN npm ci
COPY tsconfig.base.json ./
# The footer's "Notices and attribution" dialog bundles NOTICE.md (the web build fails without it).
COPY NOTICE.md ./
COPY shared shared
COPY web web
RUN npm run build

# --- Production dependencies of the server and shared packages only ---------
FROM manifests AS deps
RUN npm ci --omit=dev --workspace=@outpost/server --workspace=@outpost/shared

# --- Runtime -------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY shared/package.json shared/package.json
COPY shared/src shared/src
COPY server/package.json server/package.json
COPY server/src server/src
COPY server/data server/data
COPY --from=build /app/web/dist web/dist
COPY LICENSE NOTICE.md ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/src/main.ts"]
