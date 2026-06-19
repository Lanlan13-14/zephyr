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
# Stage 2: freerdp-build — 编译 Zephyr H.264 导出版 FreeRDP
# ============================================================
FROM alpine:3.20 AS freerdp-build

USER root
WORKDIR /tmp/FreeRDP

RUN apk add --no-cache \
        build-base cmake git linux-headers openssl-dev zlib-dev \
        alsa-lib-dev cups-dev ffmpeg-dev openh264-dev pcsc-lite-dev \
        libx11-dev libxcursor-dev libxdamage-dev libxext-dev libxfixes-dev \
        libxi-dev libxinerama-dev libxkbfile-dev libxrandr-dev libxrender-dev \
        libxtst-dev libxv-dev wayland-dev

# 编译魔改 FreeRDP：在 RDPGFX AVC420/AVC444 SurfaceCommand 解码前导出原始 H.264 bitstream。
RUN git clone --depth 1 --branch 2.11.7 https://github.com/FreeRDP/FreeRDP.git . && \
    mkdir -p /tmp/zephyr-freerdp-patches
COPY patches/freerdp-2.11.7 /tmp/zephyr-freerdp-patches
RUN /bin/sh /tmp/zephyr-freerdp-patches/apply.sh && \
    cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_FLAGS="-Wno-error=incompatible-pointer-types -Wno-error=implicit-function-declaration -Wno-error=int-conversion" \
      -DCMAKE_INSTALL_PREFIX=/opt/freerdp-zephyr \
      -DWITH_SERVER=OFF \
      -DWITH_CLIENT=ON \
      -DWITH_X11=ON \
      -DWITH_WAYLAND=OFF \
      -DWITH_OPENH264=ON \
      -DWITH_FFMPEG=ON \
      -DWITH_PULSE=OFF \
      -DWITH_CUPS=OFF \
      -DWITH_PCSC=OFF \
      -DCHANNEL_URBDRC=OFF \
      -DCHANNEL_URBDRC_CLIENT=OFF && \
    cmake --build build -j$(nproc) && \
    cmake --install build && \
    echo "BUILD_FREERDP_VERSION=$(apk list --installed 2>/dev/null | grep 'freerdp-dev' | head -1)" > /tmp/build-freerdp-version.txt

# ============================================================
# Stage 3: runtime — 精简运行镜像
# ============================================================
FROM node:20-alpine3.20

ARG ZEPHYR_VERSION=3.0.0

USER root
WORKDIR /app

RUN apk add --no-cache \
        imagemagick \
        ffmpeg \
        freerdp \
        libxrandr \
        openh264 \
        xprop \
        xrandr \
        xset \
        xsetroot \
        xvfb \
        xdotool \
        xclip \
        pulseaudio \
        alsa-plugins-pulse \
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
    && echo "=== runtime deps installed ==="

COPY --from=freerdp-build /opt/freerdp-zephyr /opt/freerdp-zephyr
COPY --from=freerdp-build /tmp/build-freerdp-version.txt /tmp/
COPY --from=app-build /app /app

ENV PATH="/opt/freerdp-zephyr/bin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/freerdp-zephyr/lib:/usr/lib/freerdp2"
ENV ZEPHYR_VERSION=${ZEPHYR_VERSION}

# 运行时诊断
RUN echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    xfreerdp /version || true && \
    find /usr/lib/freerdp2 -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | head -20 && \
    node --version && \
    npm --version && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 loaded')"

EXPOSE 3000

CMD ["node", "server.js"]
