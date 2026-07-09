# ============================================================
# Stage 1: app-build — Node.js 应用依赖
# ============================================================
FROM node:20-alpine3.20 AS app-build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 复制 @wterm 前端依赖
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist && \
    cp node_modules/@wterm/dom/src/terminal.css public/vendor/@wterm/dom/terminal.css && \
    mkdir -p public/vendor/@wterm/core && \
    cp -r node_modules/@wterm/core/dist public/vendor/@wterm/core/dist

COPY . .

# 构建编辑器 bundle
RUN npm run build:editor 2>&1 || echo "[WARN] editor build skipped"

# ============================================================
# Stage 2: rdp-client-builder — 编译 Rust/IronRDP WASM 协议栈
# ============================================================
FROM rust:1.89-slim AS rdp-client-builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends         ca-certificates build-essential pkg-config curl &&     rm -rf /var/lib/apt/lists/* &&     /usr/local/cargo/bin/rustup target add wasm32-unknown-unknown &&     /usr/local/cargo/bin/cargo install wasm-bindgen-cli --version 0.2.126 --locked

COPY rdp-client-wasm/ ./
RUN /usr/local/cargo/bin/cargo build --target wasm32-unknown-unknown --release &&     mkdir -p pkg &&     /usr/local/cargo/bin/wasm-bindgen --target web --out-dir pkg --out-name rdp_client_wasm         target/wasm32-unknown-unknown/release/rdp_client_wasm.wasm

# ============================================================
# Stage 2b: rdp-render-builder — 编译 Rust FrameCompositor WASM
# ============================================================
FROM rust:1.89-slim AS rdp-render-builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates build-essential pkg-config && \
    rm -rf /var/lib/apt/lists/* && \
    /usr/local/cargo/bin/rustup target add wasm32-unknown-unknown && \
    /usr/local/cargo/bin/cargo install wasm-bindgen-cli --version 0.2.100 --locked

COPY rdp-render-wasm/ ./
RUN /usr/local/cargo/bin/cargo build --target wasm32-unknown-unknown --release && \
    mkdir -p pkg && \
    /usr/local/cargo/bin/wasm-bindgen --target web --out-dir pkg --out-name rdp_render_wasm \
        target/wasm32-unknown-unknown/release/rdp_render_wasm.wasm

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

# RDP Rust WASM artifacts → public/vendor/rdp-client/ + public/vendor/rdp-render/
RUN mkdir -p /app/public/vendor/rdp-client /app/public/vendor/rdp-render
COPY --from=rdp-client-builder /build/pkg/ /app/public/vendor/rdp-client/
COPY --from=rdp-render-builder /build/pkg/ /app/public/vendor/rdp-render/

ENV ZEPHYR_VERSION=${ZEPHYR_VERSION}
ENV MALLOC_TRIM_THRESHOLD_=32768
ENV MALLOC_MMAP_THRESHOLD_=65536

RUN echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    node --version && \
    npm --version && \
    test -f /app/public/vendor/rdp-client/rdp_client_wasm.js && \
    test -f /app/public/vendor/rdp-client/rdp_client_wasm_bg.wasm && \
    test -f /app/public/vendor/rdp-render/rdp_render_wasm.js && \
    test -f /app/public/vendor/rdp-render/rdp_render_wasm_bg.wasm && \
    wc -c /app/public/vendor/rdp-client/rdp_client_wasm_bg.wasm /app/public/vendor/rdp-render/rdp_render_wasm_bg.wasm && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 loaded')" && \
    (HTTP_ENABLED=true HTTPS_ENABLED=false PORT=39080 node server.js > /tmp/zephyr-startup.log 2>&1 & pid=$!; ok=0; for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:39080/ >/dev/null 2>&1 && ok=1 && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; cat /tmp/zephyr-startup.log; kill "$pid" 2>/dev/null || true; rm -rf /app/data /tmp/zephyr-startup.log; test "$ok" = 1; echo "server startup smoke loaded")

EXPOSE 3443

CMD ["node", "server.js"]
