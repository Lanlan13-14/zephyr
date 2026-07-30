# ============================================================
# Stage 1: app-build — Node.js 应用依赖
# ============================================================
FROM node:20-alpine3.20 AS app-build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Terminal stack is vendored in-repo under public/vendor/wterm-fork
# (wterm DOM + XtermBridge + @xterm/headless browser bundle).
# The old step copied node_modules/@wterm/* which was removed from package.json.
RUN test -f public/vendor/wterm-fork/wterm.js && \
    test -f public/vendor/wterm-fork/core/xterm-headless.js && \
    test -f public/vendor/wterm-fork/core/xterm-bridge.js && \
    test -f public/vendor/wterm-fork/core/xterm-headless-register.js && \
    echo "terminal vendor stack present"

# Bake the latest Zephyr Agent release (agent-v*) into public/agent-release.json
# so the About / Agent settings pages link straight to the current Agent tag
# without users hopping between Docker v* and Agent agent-v* release pages.
# Network failure is non-fatal — the UI falls back to the releases index.
ARG GITHUB_TOKEN=
ARG GITHUB_REPOSITORY=Lanlan13-14/zephyr-ssh
ARG ZEPHYR_AGENT_RELEASE_TAG=
ENV GITHUB_TOKEN=${GITHUB_TOKEN}
ENV GITHUB_REPOSITORY=${GITHUB_REPOSITORY}
ENV ZEPHYR_AGENT_RELEASE_TAG=${ZEPHYR_AGENT_RELEASE_TAG}
RUN node scripts/resolve-latest-agent-release.mjs \
    && test -f public/agent-release.json \
    && echo "agent-release metadata present" \
    && cat public/agent-release.json

# Rebuild browser terminal vendor from TS sources (native esbuild on CI).
RUN npm run build:terminal

# 构建编辑器 bundle；失败必须阻断镜像，禁止继续打包陈旧产物
RUN npm run build:editor

# Runtime 不需要 devDependencies
RUN npm prune --omit=dev

# ============================================================
# Stage 2: rdp-wasm-builder — 编译 grdp Go WASM (RDP 协议栈)
# ============================================================
FROM golang:1.26-alpine AS rdp-wasm-builder

WORKDIR /build

RUN apk add --no-cache make nodejs

COPY rdp-wasm/ ./

# Build Go WASM binary (uses local grdp-patch with custom DVC handler support)
RUN go mod tidy && GOOS=js GOARCH=wasm go build -o main.wasm .

# Build one ESM runtime shared by the module Worker and page fallback. Both
# pipelines import a lexical class binding; neither relies on globalThis.
RUN cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" wasm_exec.js 2>/dev/null || \
    cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" wasm_exec.js
COPY scripts/build-go-wasm-esm.mjs /build/build-go-wasm-esm.mjs
RUN node /build/build-go-wasm-esm.mjs wasm_exec.js wasm_exec.mjs

# ============================================================
# Stage 2b: zephyr-ai-builder — Go AI runtime (SSE agent loop)
# ============================================================
FROM golang:1.26-alpine AS zephyr-ai-builder
WORKDIR /build
COPY zephyr-ai/ ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /zephyr-ai ./cmd/zephyr-ai

# ============================================================
# Stage 3: runtime — Zephyr + WASM RDP client (Alpine)
# ============================================================
FROM node:20-alpine3.20

ARG ZEPHYR_VERSION=3.0.0

USER root
WORKDIR /app

RUN apk add --no-cache \
        imagemagick \
        p7zip \
        xz \
        bzip2 \
        chromium \
        nss \
        harfbuzz \
        ttf-freefont \
        font-noto \
        font-noto-cjk \
        font-noto-emoji \
        openssl \
        curl \
        bubblewrap \
        jq \
        file \
        python3 \
        py3-pip \
        go \
        rust \
        cargo \
        ffmpeg \
    && echo "=== runtime deps installed ==="

COPY --from=app-build /app /app
COPY --from=zephyr-ai-builder /zephyr-ai /usr/local/bin/zephyr-ai
COPY scripts/docker-entrypoint-ai.sh /usr/local/bin/docker-entrypoint-ai.sh
RUN chmod +x /usr/local/bin/zephyr-ai /usr/local/bin/docker-entrypoint-ai.sh

# RDP WASM artifacts → public/vendor/rdp-wasm/
RUN mkdir -p /app/public/vendor/rdp-wasm
COPY --from=rdp-wasm-builder /build/main.wasm /app/public/vendor/rdp-wasm/
COPY --from=rdp-wasm-builder /build/wasm_exec.mjs /app/public/vendor/rdp-wasm/

ENV ZEPHYR_VERSION=${ZEPHYR_VERSION}

# Data and TLS certificate directories. Mount these as volumes or set the
# env vars to point at host paths when deploying with a real certificate.
#
#   ZEPHYR_DATA_DIR   - persistent data (SQLite, JSON stores, auto-cert)
#                       default: /app/data
#   ZEPHYR_HTTPS_DIR  - TLS certificate directory
#                       default: $ZEPHYR_DATA_DIR/https
#   HTTPS_CERT_FILE   - full path to PEM certificate file
#                       default: $ZEPHYR_HTTPS_DIR/zephyr.crt
#   HTTPS_KEY_FILE    - full path to PEM private key file
#                       default: $ZEPHYR_HTTPS_DIR/zephyr.key
#
# Quick usage (bring-your-own cert):
#   docker run -v /etc/letsencrypt/live/yourdomain:/certs:ro \
#              -e HTTPS_CERT_FILE=/certs/fullchain.pem \
#              -e HTTPS_KEY_FILE=/certs/privkey.pem \
#              ...
#
# Or just mount the data directory and drop the cert there:
#   docker run -v /host/zephyr-data:/data \
#              -e ZEPHYR_DATA_DIR=/data \
#              ...
ENV ZEPHYR_DATA_DIR=/app/data
VOLUME ["/app/data"]
ENV MALLOC_TRIM_THRESHOLD_=32768
ENV MALLOC_MMAP_THRESHOLD_=65536

RUN echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    node --version && \
    npm --version && \
    test -f /app/public/vendor/rdp-wasm/main.wasm && \
    test -f /app/public/vendor/rdp-wasm/wasm_exec.mjs && \
    test ! -f /app/public/vendor/rdp-wasm/wasm_exec.js && \
    test -f /app/public/vendor/wterm-fork/wterm.js && \
    test -f /app/public/vendor/wterm-fork/core/xterm-headless.js && \
    node --input-type=module -e "import('./public/vendor/rdp-wasm/wasm_exec.mjs').then(m => { if (typeof m.Go !== 'function') throw new Error('ESM Go export missing'); if (typeof globalThis.Go !== 'undefined') throw new Error('ESM runtime leaked globalThis.Go') })" && \
    ! grep -R -E "globalThis\\.Go|did not register globalThis\\.Go|wasm_exec\\.js" /app/public/rdp-*.js && \
    wc -c /app/public/vendor/rdp-wasm/main.wasm && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 loaded')" && \
    (HTTP_ENABLED=true HTTPS_ENABLED=false PORT=39080 node server.js > /tmp/zephyr-startup.log 2>&1 & pid=$!; ok=0; for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:39080/ >/dev/null 2>&1 && ok=1 && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; cat /tmp/zephyr-startup.log; kill "$pid" 2>/dev/null || true; rm -rf /app/data /tmp/zephyr-startup.log; test "$ok" = 1; echo "server startup smoke loaded")

# Go AI runtime defaults (loopback inside container; Node proxies SSE)
ENV ZEPHYR_AI_LISTEN=127.0.0.1:8450
ENV ZEPHYR_AI_URL=http://127.0.0.1:8450
ENV ZEPHYR_AI_DATA=/app/data/zephyr-ai
ENV ZEPHYR_AI_PLATFORM_HOST_URL=http://127.0.0.1:3080
# ZEPHYR_AI_ADMIN_TOKEN / ZEPHYR_AI_PLATFORM_HOST_TOKEN: set via env_file or -e
# (same value). If empty, entrypoint generates a per-boot token into the data dir.

EXPOSE 3443

CMD ["/usr/local/bin/docker-entrypoint-ai.sh"]
