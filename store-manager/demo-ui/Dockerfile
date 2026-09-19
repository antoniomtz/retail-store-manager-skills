# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . ./
RUN npm run build

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS runtime

ARG STORE_MANAGER_UI_SOURCE_HASH=unknown
LABEL org.opencontainers.image.title="Retail Agent Toolkit Store Manager demo UI" \
      org.opencontainers.image.description="Synthetic Store Manager operating demo" \
      io.github.antoniomtz.retail-store-manager.ui-source-hash="${STORE_MANAGER_UI_SOURCE_HASH}"

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3000 \
    STORE_MANAGER_STATE_DIR=/run/store-manager \
    HOME=/tmp

WORKDIR /app
COPY --from=build --chown=node:node /app/dist/standalone/ ./
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/store-manager-demo-ui

USER node
ENTRYPOINT ["store-manager-demo-ui"]
