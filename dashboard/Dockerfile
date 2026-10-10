# syntax=docker/dockerfile:1
# Dashboard image (context = repo root). Stages:
#   web     → Vite build of dashboard/web            → /src/dashboard/web/dist
#   server  → tsc build of dashboard/server (+shared) → /src/dashboard/server/dist
#   test    → server + web unit tests                  (make test-dash = docker build --target test)
#   runtime → node:22-slim + compiled server + SPA + contracts + oha
ARG NODE_VERSION=22

FROM node:${NODE_VERSION} AS web
WORKDIR /src/dashboard/web
COPY dashboard/web/package.json dashboard/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/shared/ /src/dashboard/shared/
COPY dashboard/web/ ./
RUN npm run build

FROM node:${NODE_VERSION} AS server
WORKDIR /src/dashboard/server
COPY dashboard/server/package.json dashboard/server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/shared/ /src/dashboard/shared/
COPY dashboard/dev/ /src/dashboard/dev/
COPY dashboard/server/ ./
RUN npm run build

FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /src/dashboard/server
COPY dashboard/server/package.json dashboard/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM server AS test
COPY --from=web /src/dashboard/web /src/dashboard/web
RUN npm run typecheck && npm test && cd /src/dashboard/web && npm test

# oha HTTP load generator (github.com/hatoo/oha), pinned + checksum-verified per arch.
FROM node:${NODE_VERSION} AS oha
ARG TARGETARCH
ARG OHA_VERSION=1.16.0
ARG OHA_SHA256_AMD64=620bb9e16fb53eabc9a3fc45f88bdb41fefa3fee5c05e75892011ce320391716
ARG OHA_SHA256_ARM64=99a790eb8c3e0feaca974bd6b32f0f8d4426a0c5b289f39e833e5b2c7529cd39
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) asset=oha-linux-amd64; sum="$OHA_SHA256_AMD64" ;; \
      arm64) asset=oha-linux-arm64; sum="$OHA_SHA256_ARM64" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /oha "https://github.com/hatoo/oha/releases/download/v${OHA_VERSION}/${asset}"; \
    echo "${sum}  /oha" | sha256sum -c -; \
    chmod 0755 /oha

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web/dist \
    CONTRACTS_DIR=/contracts \
    REPORTS_DIR=/reports \
    OHA_PATH=/usr/local/bin/oha
WORKDIR /app/server
COPY --from=oha /oha /usr/local/bin/oha
COPY --from=prod-deps /src/dashboard/server/node_modules ./node_modules
COPY dashboard/server/package.json ./
COPY --from=server /src/dashboard/server/dist ./dist
COPY --from=web /src/dashboard/web/dist /app/web/dist
COPY contracts /contracts
# Files are root-owned but world-readable, so the image also runs as `node` (uid 1000), e.g. in k8s.
# Compose runs it as root because it needs the Docker socket.
RUN mkdir -p /reports && chmod 0777 /reports && /usr/local/bin/oha --version
EXPOSE 3000
CMD ["node", "dist/server/src/index.js"]
