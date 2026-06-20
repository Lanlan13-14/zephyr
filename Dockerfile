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
# Stage 2: freerdp3-builder — 编译 FreeRDP3 RDPEGFX/H.264 (musl)
# ============================================================
FROM alpine:3.20 AS freerdp3-builder

ARG FREERDP_VERSION=3.20.0
WORKDIR /build

RUN apk add --no-cache \
        build-base cmake ninja git pkgconf \
        linux-headers \
        openssl-dev \
        libx11-dev libxext-dev libxinerama-dev libxcursor-dev \
        libxkbfile-dev libxv-dev libxi-dev libxdamage-dev \
        libxrandr-dev libxrender-dev libxfixes-dev \
        fuse3-dev alsa-lib-dev cups-dev pulseaudio-dev \
        eudev-dev dbus-glib-dev util-linux-dev libxml2-dev \
        krb5-dev libusb-dev cjson-dev \
        sdl2-dev sdl2_ttf-dev pcsc-lite-dev \
        ffmpeg-dev opus-dev libwebp-dev cairo-dev \
        zlib-dev

RUN git clone --depth 1 --branch ${FREERDP_VERSION} https://github.com/FreeRDP/FreeRDP.git freerdp

WORKDIR /build/freerdp
RUN cmake -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/freerdp3 \
      -DWITH_VERBOSE_WINPR_ASSERT=OFF \
      -DWITH_SERVER=OFF \
      -DWITH_SAMPLE=OFF \
      -DWITH_MANPAGES=OFF \
      -DWITH_FFMPEG=ON \
      -DWITH_SWSCALE=ON \
      -DWITH_DSP_FFMPEG=ON \
      -DWITH_VIDEO_FFMPEG=ON \
      -DWITH_OPUS=ON \
      -DWITH_WEBVIEW=OFF \
      -DWITH_PKCS11=OFF \
      -DWITH_CLIENT_SDL=OFF \
      -DWITH_PROXY=OFF \
      -DWITH_SHADOW=OFF \
      -DCHANNEL_RDPGFX=ON \
      -DCHANNEL_RDPSND=ON \
      -DCHANNEL_DISP=ON \
      -DCHANNEL_CLIPRDR=ON \
      -DWITH_PULSE=OFF \
      -DWITH_ALSA=OFF \
    && cmake --build build --parallel $(nproc) \
    && cmake --install build \
    && echo "FreeRDP3 musl build done" \
    && ls /opt/freerdp3/lib/libfreerdp3* 2>/dev/null | head -5

# ============================================================
# Stage 3: rdp-bridge-builder — 编译 freerdp-web native bridge (musl)
# ============================================================
FROM alpine:3.20 AS rdp-bridge-builder

WORKDIR /build

RUN apk add --no-cache \
        build-base cmake pkgconf \
        openssl-dev opus-dev ffmpeg-dev cjson-dev \
        krb5-dev pcsc-lite-dev fuse3-dev libwebp-dev cairo-dev

COPY --from=freerdp3-builder /opt/freerdp3 /opt/freerdp3
ENV PKG_CONFIG_PATH=/opt/freerdp3/lib/pkgconfig
ENV LD_LIBRARY_PATH=/opt/freerdp3/lib

COPY rdp-gfx-backend/native/ ./native/
WORKDIR /build/native
RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/usr/local \
      -DCMAKE_PREFIX_PATH=/opt/freerdp3 \
      -DFREERDP3_DIR=/opt/freerdp3 \
    && cmake --build build --parallel $(nproc) \
    && cmake --install build \
    && ls -la /usr/local/lib/librdp_bridge.so* \
    && ls -la /usr/local/lib/freerdp3/librdpsnd-client-bridge.so

# ============================================================
# Stage 4: rdp-wasm-builder — 编译 Progressive/ClearCodec WASM
# ============================================================
FROM emscripten/emsdk:3.1.51 AS rdp-wasm-builder

WORKDIR /build
COPY public/vendor/freerdp-web/progressive/ ./progressive/
COPY public/vendor/freerdp-web/clearcodec/ ./clearcodec/

WORKDIR /build/progressive
RUN mkdir -p build && cd build && emcmake cmake .. && emmake make

WORKDIR /build/clearcodec
RUN mkdir -p build && cd build && emcmake cmake .. && emmake make

# ============================================================
# Stage 5: runtime — Zephyr + RDPEGFX/FreeRDP3 bridge (Alpine)
# ============================================================
FROM node:20-alpine3.20

ARG ZEPHYR_VERSION=3.0.0

USER root
WORKDIR /app

RUN apk add --no-cache \
        imagemagick \
        ffmpeg \
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
        python3 \
        py3-pip \
        opus \
        libwebp \
        cjson \
        krb5 \
        pcsc-lite \
        pcsc-lite-libs \
        fuse3 \
        cairo \
        libx11 \
        libxkbfile \
        libxext \
        libxinerama \
        libxcursor \
        libxv \
        libxi \
        libxdamage \
        libxrandr \
        libxrender \
        libxfixes \
        libxml2 \
        eudev-libs \
        dbus-glib \
        alsa-lib \
        sdl2 \
        sdl2_ttf \
        libusb \
        cups-libs \
        openssl \
        curl \
    && echo "=== runtime deps installed ==="

COPY --from=app-build /app /app
COPY --from=freerdp3-builder /opt/freerdp3 /opt/freerdp3
COPY --from=rdp-bridge-builder /usr/local/lib/librdp_bridge.so* /usr/local/lib/
COPY --from=rdp-bridge-builder /usr/local/include/rdp_bridge.h /usr/local/include/
RUN mkdir -p /opt/freerdp3/lib/freerdp3
COPY --from=rdp-bridge-builder /usr/local/lib/freerdp3/librdpsnd-client-bridge.so /opt/freerdp3/lib/freerdp3/

COPY --from=rdp-wasm-builder /build/progressive/build/progressive_decoder.js /app/public/vendor/freerdp-web/progressive/
COPY --from=rdp-wasm-builder /build/progressive/build/progressive_decoder.wasm /app/public/vendor/freerdp-web/progressive/
COPY --from=rdp-wasm-builder /build/progressive/build/progressive_decoder.worker.js /app/public/vendor/freerdp-web/progressive/
COPY --from=rdp-wasm-builder /build/clearcodec/build/clearcodec_decoder.js /app/public/vendor/freerdp-web/clearcodec/
COPY --from=rdp-wasm-builder /build/clearcodec/build/clearcodec_decoder.wasm /app/public/vendor/freerdp-web/clearcodec/

RUN python3 -m venv /app/venv
ENV PATH="/app/venv/bin:${PATH}"
RUN pip install --no-cache-dir -r /app/rdp-gfx-backend/requirements.txt

ENV LD_LIBRARY_PATH="/opt/freerdp3/lib:/usr/local/lib"
ENV FREERDP_LIBRARY_PATH="/opt/freerdp3/lib/freerdp3"
ENV RDP_GFX_BACKEND_HOST="127.0.0.1"
ENV RDP_GFX_BACKEND_PORT="8765"
ENV ZEPHYR_VERSION=${ZEPHYR_VERSION}
ENV MALLOC_TRIM_THRESHOLD_=32768
ENV MALLOC_MMAP_THRESHOLD_=65536

RUN echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    node --version && \
    npm --version && \
    for lib in /usr/local/lib/librdp_bridge.so /opt/freerdp3/lib/libfreerdp3.so.3 /opt/freerdp3/lib/libwinpr3.so.3 /opt/freerdp3/lib/freerdp3/librdpsnd-client-bridge.so; do ldd "$lib"; done && \
    python -c "import ctypes; ctypes.CDLL('/usr/local/lib/librdp_bridge.so'); print('librdp_bridge loaded')" && \
    test -f /app/public/vendor/freerdp-web/progressive/progressive_decoder.wasm && \
    test -f /app/public/vendor/freerdp-web/clearcodec/clearcodec_decoder.wasm && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 loaded')"

EXPOSE 3443

CMD ["node", "server.js"]
