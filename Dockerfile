# ============================================================
# Stage 1: app-build — Node.js 应用依赖
# ============================================================
FROM node:20-alpine3.20 AS app-build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# 复制 @wterm 前端依赖
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist && \
    cp node_modules/@wterm/dom/src/terminal.css public/vendor/@wterm/dom/terminal.css && \
    mkdir -p public/vendor/@wterm/core && \
    cp -r node_modules/@wterm/core/dist public/vendor/@wterm/core/dist

COPY . .

# 构建编辑器 bundle；失败必须阻断镜像，禁止继续打包陈旧产物
RUN npm run build:editor

# Runtime 不需要 devDependencies
RUN npm prune --omit=dev

# ============================================================
# Stage 2: rdp-wasm-builder — 编译 grdp Go WASM (RDP 协议栈)
# ============================================================
FROM golang:1.26-alpine AS rdp-wasm-builder

WORKDIR /build

RUN apk add --no-cache make

COPY rdp-wasm/ ./

# Build Go WASM binary (uses local grdp-patch with custom DVC handler support)
RUN go mod tidy && GOOS=js GOARCH=wasm go build -o main.wasm .

# Copy wasm_exec.js from Go SDK
RUN cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" wasm_exec.js 2>/dev/null || \
    cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" wasm_exec.js

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
    && echo "=== runtime deps installed ==="

COPY --from=app-build /app /app

# RDP WASM artifacts → public/vendor/rdp-wasm/
RUN mkdir -p /app/public/vendor/rdp-wasm
COPY --from=rdp-wasm-builder /build/main.wasm /app/public/vendor/rdp-wasm/
COPY --from=rdp-wasm-builder /build/wasm_exec.js /app/public/vendor/rdp-wasm/

ENV ZEPHYR_VERSION=${ZEPHYR_VERSION}
ENV MALLOC_TRIM_THRESHOLD_=32768
ENV MALLOC_MMAP_THRESHOLD_=65536

RUN echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    node --version && \
    npm --version && \
    test -f /app/public/vendor/rdp-wasm/main.wasm && \
    test -f /app/public/vendor/rdp-wasm/wasm_exec.js && \
    wc -c /app/public/vendor/rdp-wasm/main.wasm && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 loaded')" && \
    (HTTP_ENABLED=true HTTPS_ENABLED=false PORT=39080 node server.js > /tmp/zephyr-startup.log 2>&1 & pid=$!; ok=0; for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:39080/ >/dev/null 2>&1 && ok=1 && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; cat /tmp/zephyr-startup.log; kill "$pid" 2>/dev/null || true; rm -rf /app/data /tmp/zephyr-startup.log; test "$ok" = 1; echo "server startup smoke loaded")

EXPOSE 3443

CMD ["node", "server.js"]
