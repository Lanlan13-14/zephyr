<p align="center">
  <img src="public/zephyr-mark.svg" width="96" height="96" alt="Zephyr Logo" />
</p>

<h1 align="center">Zephyr</h1>

<p align="center">
  Unified Multi-Platform Remote Infrastructure & Agent Platform
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#chinese">中文</a>
</p>

---

<a name="english"></a>
## English

### Notice on Project Status & Multi-Platform Scope

> **Important Notice on Implementation Status & Development Cadence**:  
> Many modules across the Zephyr ecosystem (specifically cross-platform execution engines, isolated AI sandboxes, and native mobile client bindings) are currently in early, transitional, or partial completion states.  
> Due to the physical limitations of individual developer bandwidth, progress across all platforms proceeds at a measured pace.  
> However, the architectural objective remains absolute: to achieve rigorous convergence in functional parity, security guarantees, and user operational logic across web, desktop, and mobile environments.

---

### Table of Contents

- [System Architecture](#system-architecture)
- [Subsystem Breakdown](#subsystem-breakdown)
  - [Zephyr Server (Control & Data Plane)](#zephyr-server-control--data-plane)
  - [Zephyr One (Desktop & Mobile Clients)](#zephyr-one-desktop--mobile-clients)
  - [Zephyr AI & Zephyr Cell (Agent & Sandbox)](#zephyr-ai--zephyr-cell-agent--sandbox)
  - [Zephyr Link & Zephyr Agent (Transport & Edge)](#zephyr-link--zephyr-agent-transport--edge)
- [Protocol & Routing Capabilities](#protocol--routing-capabilities)
- [Deployment & Operations](#deployment--operations)
  - [Production Docker Run](#production-docker-run)
  - [Docker Compose](#docker-compose)
  - [Environment Configuration Table](#environment-configuration-table)
  - [Data Persistence & Upgrades](#data-persistence--upgrades)
- [Building from Source](#building-from-source)
- [Repository Layout](#repository-layout)
- [Security Best Practices](#security-best-practices)
- [Sponsorship & Upstream Credits](#sponsorship--upstream-credits)
- [License](#license)

---

### System Architecture

Zephyr decouples the administrative web interface, client runtimes, execution engines, and communication overlays into dedicated layers:

```text
+-----------------------------------------------------------------------+
|                           Zephyr One Clients                          |
|  - Desktop (Electron + local Node core + node:sqlite on loopback)     |
|  - Mobile Android (Kotlin + Jetpack Compose + Room + Keystore)        |
|  - Mobile iOS (Swift + SwiftUI + Keychain + SQLiteSync)               |
+-----------------------------------------------------------------------+
                                    |
                                    | (HTTPS / WSS / ZSL-2 E2EE Overlay)
                                    v
+-----------------------------------------------------------------------+
|                       Zephyr Server (Main Host)                       |
|  +-- Node.js Control Plane (Auth, ACL, Notes, Metadata, WebDAV)       |
|  +-- zephyr-worker (Go PTY Supervisor, Stream Distribution, Telnet)   |
|  +-- zephyr-link-server (Go ZSL/2 Engine, KEM Handshake, Tunnel Hub)  |
|  +-- zephyr-ai (Go SSE Agent Loop, Tool Dispatcher, Reasoning Engine) |
+-----------------------------------------------------------------------+
            |                                               |
            | (Direct Dial / Chained SSH)                   | (Sealed Stream)
            v                                               v
+-----------------------+                       +-----------------------+
| Target Infrastructure |                       |     Zephyr Agent      |
|  - SSH Servers        |                       |  - Flutter Daemon     |
|  - Telnet Hosts       |                       |  - Reverse Bastion    |
|  - RDP / VNC Desktops |                       |  - TSCLIENT Redir     |
+-----------------------+                       +-----------------------+
```

---

### Subsystem Breakdown

#### Zephyr Server (Control & Data Plane)
- **Node.js Core**: Manages HTTP/WebSocket ingress, authentication workflows, access control lists (ACL), encrypted database migrations, WebDAV backup synchronization, and static asset distribution.
- **Go PTY Supervisor (`zephyr-worker`)**: Dedicated Go daemon handling interactive PTY lifecycles, ring-buffer output history caching, NAWS/IAC Telnet state machines, and WebSocket stream fan-out. Active terminal sessions survive network drops and browser refreshes without losing output.
- **DOM-Based WebSSH (`@wterm/dom`)**: Replaces Canvas-based terminal renderers with true DOM text nodes, enabling native drag-selection, text copying, mobile contextual menus, and IME input composition.
- **In-Browser WASM RDP (`rdp-wasm`)**: Client-side Go WASM build based on patched `grdp`. Decodes RDP graphics via WebCodecs (AVC420 / AVC444) and composites on WebGL2 FBOs. Implements Windows MS-RDPEFS and CLIPRDR virtual channels, supporting native clipboard file synchronization without server-side FreeRDP dependencies.
- **Envelope Encryption at Rest**: Passwords, private keys, jump-host secrets, and MFA seeds are encrypted using hybrid post-quantum ML-KEM-768 + AES-256-GCM before disk persistence.

#### Zephyr One (Desktop & Mobile Clients)
- **Desktop Client (`zephyr_one`)**:
  - Built with **Electron 37** running a local embedded Zephyr Node.js instance on loopback (`127.0.0.1`).
  - Utilizes Node 22 built-in `node:sqlite` (`ZEPHYR_ONE_USE_BUILTIN_SQLITE=1`), removing the need to compile native C++ addons (`better-sqlite3`) on end-user machines.
  - Automatic local account adoption eliminates browser-era credential barriers.
  - Optional OS biometric unlocking via native platform APIs (macOS LocalAuthentication via JXA, Windows UserConsentVerifier via PowerShell).
  - Remote main servers act solely as sync endpoints; day-to-day SSH, RDP, VNC, and AI operations execute on the local core.
- **Android Client (`zephyr_one/mobile/android`)**:
  - Written in native Kotlin with Jetpack Compose UI.
  - Custom Liquid Glass rendering via AGSL shaders.
  - Hardware-backed key generation via Android Keystore; offline SQLite storage via Room.
  - Runs an embedded `libzephyr_link.so` loopback process to handle ZSL/2 cryptographic tunneling.
- **iOS Client (`zephyr_one/mobile/ios`)**:
  - Implemented in native Swift with SwiftUI.
  - Secure hardware credential management via iOS Keychain; structured synchronization engine via `SQLiteSyncRepository`.

#### Zephyr AI & Zephyr Cell (Agent & Sandbox)
- **Go AI Runtime (`zephyr-ai`)**:
  - High-performance, streaming SSE agent loop supporting multi-provider LLMs (OpenAI, Anthropic, Gemini, DeepSeek, and custom OpenAI-compatible endpoints).
  - Turn orchestration featuring reasoning token folding, dynamic thinking depth regulation, and context compaction.
  - Tool execution harness supporting platform observation, file operations, web browsing, and human-in-the-loop permission prompts.
- **Execution Sandbox (`zephyr-cell`)**:
  - Replaces fragile command-name whitelists with an isolated Linux execution space.
  - Utilizes Bubblewrap (`bwrap`) and kernel namespaces on Linux/Docker hosts for unprivileged process isolation.
  - Enforces read-only root mounts, private session workspaces, default network isolation namespaces, 100KB automatic output truncation, and immutable NDJSON audit logs.
  - Designed with an abstraction layer supporting Direct, PRoot, CellVM, and remote server routing.

#### Zephyr Link & Zephyr Agent (Transport & Edge)
- **Zephyr Link Protocol (`zephyr-link`)**:
  - Application-layer overlay protocol engineered to pass through standard CDNs (e.g., Cloudflare) over WebSocket (WSS) without exposing payload plaintext to intermediate TLS-terminating proxies.
  - Employs ZSL/2 hybrid encryption: `X25519` + `ML-KEM-768` (FIPS 203) key exchange, HKDF-SHA256 key derivation, and AES-256-GCM AEAD framing.
  - Passwordless device enrollment using out-of-band browser approval, Short Authentication String (SAS) verification, and hardware-attested transcript binding.
  - Multiplexes isolated channels for sync operations, blob transfer, and encrypted TCP bastion tunneling (`KindAgentTunnel`).
- **Zephyr Agent (`zephyr_agent`)**:
  - Multi-platform companion daemon written in Flutter (supporting Android, macOS, Linux, and Windows).
  - Connects outbound to Zephyr Server over Link, exposing target machines behind NAT as accessible bastion jump hosts.
  - Implements MS-RDPEFS disk redirection, exposing edge storage as a `\\tsclient` network drive inside RDP sessions.

---

### Protocol & Routing Capabilities

| Protocol | As Target Host | Through Proxy | Through SSH Jump Host | As Jump Host |
|---|---|---|---|---|
| `SSH` | [Supported] | [Supported] | [Supported] | [Supported] |
| `Telnet` | [Supported] | [Supported] | [Supported] | [No] |
| `RDP` | [Supported] | [Supported] | [Supported] | [No] |
| `VNC` | [Supported] | [Supported] | [Supported] | [No] |

- **Chained Bastion Traversal**: Supports arbitrary multi-tier SSH jump hops. Zephyr establishes dynamic port proxies at each intermediate hop to reach isolated internal subnets.
- **Telnet Routing**: Telnet sessions utilize `createRoutedTcpForward` to tunnel raw Telnet streams through SOCKS5/HTTP proxies and SSH bastion chains (`direct-tcpip`). Telnet targets support encrypted-at-rest in-band auto-login, but cannot serve as jump hosts themselves.
- **RDP over Bastion Pipeline**: Browser WASM RDP client -> WebSocket -> Zephyr Node.js proxy -> SSH jump chain -> Target RDP host:3389.
- **VNC over Bastion Pipeline**: Browser noVNC client -> WebSocket -> Zephyr VNC proxy (handles VNCAuth) -> SSH jump chain -> Target VNC host:5900.

---

### Deployment & Operations

#### Production Docker Run

Bind-mount a persistent host directory to `/app/data`. The SQLite database, encryption keypairs, session logs, and local backups are stored here.

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=replace-with-a-secure-random-32-byte-base64-key
PUBLIC_ORIGIN=https://zephyr.example.com
PORT=3000
EOF

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

Access the application at `http://your-server-ip:3000`.  
Default Administrative Credentials:
- **Username**: `admin`
- **Password**: `admin` (Mandatory password change enforced upon initial login).

#### Docker Compose

```yaml
version: '3.8'

services:
  zephyr:
    image: ghcr.io/lanlan13-14/zephyr-ssh:latest
    container_name: zephyr
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./zephyr-data:/app/data
    environment:
      - PORT=3000
      - PUBLIC_ORIGIN=https://zephyr.example.com
      - ENCRYPTION_KEY=replace-with-a-secure-random-32-byte-base64-key
```

#### Environment Configuration Table

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP/WebSocket listening port | `3000` |
| `PUBLIC_ORIGIN` | Public canonical origin URL (required for WebAuthn RP verification) | Mandatory in production |
| `ENCRYPTION_KEY` | High-entropy 32-byte random key for credential envelope encryption | Mandatory |
| `ZEPHYR_DATA_DIR` | Directory path for persistent storage | `/app/data` |
| `ZEPHYR_AI_LISTEN` | Loopback address for the internal Go AI daemon | `127.0.0.1:8450` |
| `ZEPHYR_AI_URL` | Upstream URL for Node to reach the Go AI runtime | `http://127.0.0.1:8450` |
| `HTTPS_CERT_FILE` | Absolute path to custom PEM certificate file (optional) | Empty |
| `HTTPS_KEY_FILE` | Absolute path to custom PEM private key file (optional) | Empty |

#### Data Persistence & Upgrades

To upgrade the Docker container while preserving all configurations, keys, and session records:

```bash
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest
docker stop zephyr-ssh
docker rm zephyr-ssh
# Re-run docker run with the existing host volume: -v "$(pwd)/zephyr-data:/app/data"
```

---

### Building from Source

#### Prerequisites
- Node.js >= 20.x, npm >= 10.x
- Go >= 1.26
- Build essentials (make, gcc / clang)
- Bubblewrap, ImageMagick, Chromium (for headless browser automation)

#### Compilation Steps

```bash
# 1. Install Node dependencies
npm ci

# 2. Build RDP client Go WASM
cd rdp-wasm
go mod tidy
GOOS=js GOARCH=wasm go build -o ../public/vendor/rdp-wasm/main.wasm .
cd ..

# 3. Build terminal and editor bundles
npm run build:terminal
npm run build:editor

# 4. Compile Go AI runtime and Link transport binaries
cd zephyr-ai && go build -o /usr/local/bin/zephyr-ai ./cmd/zephyr-ai && cd ..
cd zephyr-link && go build -o /usr/local/bin/zephyr-link-server ./cmd/zephyr-link-server && cd ..

# 5. Launch service
npm start
```

---

### Repository Layout

```text
.
+-- server.js               # Node.js service entry & HTTP/WS reverse proxy
+-- ai-*.js                 # Node-side AI orchestration, tools, and session bridge
+-- link-v2-*.js            # Zephyr Link transport proxies, enrollment, and ZSL/2 bridge
+-- mobile-v1-*.js          # Mobile sync routes, blob manager, and crypto entity handlers
+-- public/                 # Static web assets, themes, and client scripts
|   +-- app.html / app.js   # Main operations workbench SPA
|   +-- terminal.*          # DOM-rendered WebSSH terminal surface (@wterm/dom)
|   +-- rdp.*               # WebCodecs + WebGL2 WASM RDP display surface
|   +-- vendor/             # Vendored frontend modules (wterm, xterm, monaco)
+-- zephyr-ai/              # Go AI Agent loop, MCP tools, and SSE execution server
+-- zephyr-cell/            # Go Linux sandbox execution framework (bwrap/direct)
+-- zephyr-link/            # Go ZSL/2 protocol core, hybrid KEM, and tunnel hub
+-- zephyr-worker/          # Go PTY session supervisor and stream distributor
+-- zephyr_one/             # Client applications
|   +-- electron/           # Desktop One Electron main process and window lifecycle
|   +-- src/                # Desktop One frontend UI (Vite + Vue/Vanilla)
|   +-- mobile/android/     # Android One (Kotlin, Jetpack Compose, AGSL)
|   +-- mobile/ios/         # iOS One (Swift, SwiftUI, Keychain)
+-- zephyr_agent/           # Edge host daemon for disk mapping and bastion hops (Flutter)
+-- rdp-wasm/               # Go WASM RDP client source and patched grdp engine
+-- Dockerfile              # Multi-stage production container build
```

---

### Security Best Practices

1. **Immediate Credential Reset**: Change default administrative passwords on initial launch.
2. **Master Key Backup**: Safely backup `data/crypto/ml-kem-768-keypair.json`. Without this file, encrypted credentials and private keys cannot be decrypted.
3. **Hardened Reverse Proxy**: Always run Zephyr behind an HTTPS reverse proxy (Caddy, Nginx, or Cloudflare) enforcing TLS 1.3.
4. **Access Control Filtering**: Restrict management endpoints using the built-in IP whitelist.
5. **Deterministic Dependencies**: Lock `package-lock.json` and `go.sum` to prevent upstream dependency hijacking.

---

### Sponsorship & Upstream Credits

We express sincere gratitude to **[LightCone](https://www.lightcone.hk/)** for sponsoring this project.

Special recognition to upstream libraries and foundational projects:
- [wterm](https://github.com/vercel-labs/wterm)
- [ssh2](https://github.com/mscdex/ssh2)
- [SimpleWebAuthn](https://simplewebauthn.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

### License

Zephyr is released under the **GNU General Public License v3.0** ([GPL-3.0](LICENSE)).

---

<a name="chinese"></a>
## 中文

### 项目现状与多端推进声明

> **实现完成度重要说明**：  
> Zephyr 生态体系中的多个底层模块（特别是跨平台沙箱执行引擎、AI 运维隔离层、以及移动端原生客户端绑定）目前仍处于早期演进与部分未完成状态。  
> 受限于开发者个人精力的客观限制，全端特性的同步推进与交付速度相对平缓。  
> 但项目的核心架构目标始终坚决贯彻：在网页端、桌面端与移动端形态中，追求功能能力、安全基准与交互逻辑的深度统一。

---

### 目录

- [系统总体架构](#系统总体架构)
- [生态组件划分](#生态组件划分)
  - [Zephyr Server（主控端与数据面）](#zephyr-server主控端与数据面)
  - [Zephyr One（桌面端与移动端）](#zephyr-one桌面端与移动端)
  - [Zephyr AI 与 Zephyr Cell（智能体与沙箱）](#zephyr-ai-与-zephyr-cell智能体与沙箱)
  - [Zephyr Link 与 Zephyr Agent（传输层与边缘跳板）](#zephyr-link-与-zephyr-agent传输层与边缘跳板)
- [协议与动态路由矩阵](#协议与动态路由矩阵)
- [快速开始与生产部署](#快速开始与生产部署)
  - [Docker 标准运行](#docker-标准运行)
  - [Docker Compose 部署](#docker-compose-部署)
  - [环境参数配置表](#环境参数配置表)
  - [持久化存储与镜像更新](#持久化存储与镜像更新)
- [从源码构建](#从源码构建)
- [代码仓库目录结构](#代码仓库目录结构)
- [安全合规建议](#安全合规建议)
- [赞助商与致谢](#赞助商与致谢)
- [开源许可证](#开源许可证)

---

### 系统总体架构

Zephyr 采用控制面与数据面解耦的分层设计，保障运维指令、图形界面和跳板数据流的高效流通：

```text
+-----------------------------------------------------------------------+
|                           Zephyr One 客户端                           |
|  - 桌面端 (Electron + 本地 Node 核心 + 内置 node:sqlite 钉死在回环)    |
|  - 安卓端 (Kotlin 原生 + Jetpack Compose + Room + Keystore 硬件密钥)   |
|  - iOS 端 (Swift 原生 + SwiftUI + Keychain 凭据安全存储 + SQLiteSync)  |
+-----------------------------------------------------------------------+
                                    |
                                    | (HTTPS / WSS / ZSL-2 应用层加密通道)
                                    v
+-----------------------------------------------------------------------+
|                       Zephyr Server (主端服务)                        |
|  +-- Node.js 控制面 (用户鉴权、ACL、笔记、元数据、WebDAV 备份)         |
|  +-- zephyr-worker (持久 PTY 监管进程、增量流分发、RFC Telnet 状态机)  |
|  +-- zephyr-link-server (Go ZSL/2 密码学协议核心与隧道 Hub)            |
|  +-- zephyr-ai (Go 语言流式 SSE Agent Loop、工具分发与推演引擎)        |
+-----------------------------------------------------------------------+
            |                                               |
            | (直接拨号 / 多级 SSH 级联)                     | (密封流式信道)
            v                                               v
+-----------------------+                       +-----------------------+
| 目标运维基础设施      |                       |     Zephyr Agent      |
|  - SSH 服务器         |                       |  - Flutter 守护进程   |
|  - Telnet 主机        |                       |  - 反向跳板穿透       |
|  - RDP / VNC 图形桌面 |                       |  - TSCLIENT 虚拟磁盘  |
+-----------------------+                       +-----------------------+
```

---

### 生态组件划分

#### Zephyr Server（主控端与数据面）
- **Node.js 核心**：负责 HTTP/WebSocket 请求分发、用户身份认证、细粒度 ACL 访问控制、基于 SQLite 的数据持久化迁移、WebDAV 加密备份同步以及 Web 静态资源托管。
- **持久 PTY 监管服务（`zephyr-worker`）**：独立的 Go 语言守护进程，管理交互式 PTY 的完整生命周期，维护环形缓冲区历史输出缓存，处理 RFC 标准的 IAC/NAWS/TTYPE Telnet 状态协商，并执行 WebSocket 数据分发。终端进程脱离浏览器独立存活，掉线或刷新页面即可无缝回显历史会话。
- **DOM 高保真 WebSSH（`@wterm/dom`）**：废弃 Canvas 终端渲染方案，采用纯 DOM 文本节点排版。支持原生鼠标拖拽滑动选区、系统级复制粘贴、移动端长按上下文菜单与原生输入法无遮挡输入。
- **纯前端 WASM RDP 引擎（`rdp-wasm`）**：基于打补丁的 `grdp` 编译出的 Go WASM 客户端，直接在浏览器内解码 RDP 协议，服务端彻底免除 FreeRDP、Python 或 X11 相关库的沉重依赖。利用 WebCodecs 进行 AVC420 / AVC444 硬件加速解码，基于 WebGL2 FBO 合成渲染，完整支持 MS-RDPEFS 与 Windows CLIPRDR 双向剪贴板文件同步。
- **敏感数据静态信封加密**：服务器连接密码、SSH 私钥、代理认证凭据及 TOTP 种子在存入数据库前，全面采用后量子混合算法 ML-KEM-768 + AES-256-GCM 封装加密。

#### Zephyr One（桌面端与移动端）
- **桌面端（`zephyr_one`）**：
  - 基于 **Electron 37** 构建，内嵌运行本地 Node.js Zephyr 核心，完全绑定在本地回环地址（`127.0.0.1`）。
  - 全面使用 Node 22 原生内置的 `node:sqlite`（`ZEPHYR_ONE_USE_BUILTIN_SQLITE=1`），彻底消除了终端用户安装时对 C++ 本地编译工具链（`better-sqlite3`）的依赖。
  - 启动时自动采纳本地管理员会话，移除浏览器时代的账号密码拦截壁垒。
  - 可选接入操作系统原生安全认证（macOS 通过 JXA 调用 LocalAuthentication，Windows 通过 PowerShell 调用 UserConsentVerifier）。
  - 远程主端仅用于账号数据双向同步，日常的 SSH、RDP、VNC 连接管理与 AI 交互均由本地核心就地处理。
- **安卓端（`zephyr_one/mobile/android`）**：
  - 采用现代原生 Kotlin 与 Jetpack Compose 开发。
  - 基于 Android AGSL 自研着色器实现 Liquid Glass 动态材质。
  - 依托 Android Keystore 生成硬件隔离密钥，通过 Room 进行离线数据持久化。
  - 提取并启动轻量级 `libzephyr_link.so` 回环子进程，无缝处理 ZSL/2 加密与隧道通讯。
- **iOS 端（`zephyr_one/mobile/ios`）**：
  - 基于原生 Swift 与 SwiftUI 构建。
  - 接入 iOS Keychain 硬件级保护存储 ML-KEM 设备凭据，基于 `SQLiteSyncRepository` 落地离线增量同步。

#### Zephyr AI 与 Zephyr Cell（智能体与沙箱）
- **Go 语言 AI 运行时（`zephyr-ai`）**：
  - 高性能、流式 SSE 智能体调度核心，支持接入 OpenAI、Anthropic、Gemini、DeepSeek 及标准兼容格式的多模型供应商。
  - 具备推演过程折叠、多档思考深度调节、上下文智能滑动压缩与子代理并行分工能力。
  - 内置工具执行框架，覆盖远程命令执行、文件管理、无头浏览器观察与高危操作人工二次审批卡片。
- **隔离执行沙箱（`zephyr-cell`）**：
  - 替代易受绕过的传统命令名称白名单，向智能体提供具备真实 Linux 用户态的隔离执行环境。
  - 在 Linux/Docker 宿主上基于 Bubblewrap（`bwrap`）与内核命名空间进行非特权隔离。
  - 强制实行根文件系统只读挂载、独立工作区隔离、默认剥离网络命名空间、100KB 输出超限截断与不可篡改的 NDJSON 结构化审计流水。
  - 架构上支持 Direct、PRoot、CellVM 引擎抽象与远端主端调度回退机制。

#### Zephyr Link 与 Zephyr Agent（传输层与边缘跳板）
- **Zephyr Link 安全覆盖网协议（`zephyr-link`）**：
  - 专为穿透 Cloudflare 等普通商业 CDN 设计的应用层传输通道，依托 WebSocket（WSS）承载，杜绝 CDN 终止外层 TLS 时窥探内层业务明文。
  - 采用 ZSL/2 混合后量子加密规范：`X25519` + `ML-KEM-768`（FIPS 203）密钥交换、HKDF-SHA256 密钥导出与 AES-256-GCM AEAD 密文封装。
  - 免密码设备绑定流程：通过系统浏览器外带审批与短认证串（SAS）防篡改核验，将私钥牢固锚定在物理设备端。
  - 多路复用数据通道，支持配置同步、大容量内容寻址分块传输（FastCDC）以及端到端加密的 TCP 跳板隧道（`KindAgentTunnel`）。
- **Zephyr Agent 边缘伴生节点（`zephyr_agent`）**：
  - 基于 Flutter 打造的跨端边缘服务（支持 Android、macOS、Linux、Windows）。
  - 主动向 Zephyr Server 发起 Link 连接，将 NAT 内部受保护的局域网资源反向暴露为可访问的运维跳板。
  - 实现 MS-RDPEFS 磁盘驱动器重定向协议，把边缘设备存储挂载为 RDP 远端桌面中的 `\\tsclient` 虚拟驱动器。

---

### 协议与动态路由矩阵

| 协议类型 | 作为目标主机 | 支持代理穿透 | 支持 SSH 跳板机访问 | 支持作为跳板机 |
|---|---|---|---|---|
| `SSH` | [支持] | [支持] | [支持] | [支持] |
| `Telnet` | [支持] | [支持] | [支持] | [不支持] |
| `RDP` | [支持] | [支持] | [支持] | [不支持] |
| `VNC` | [支持] | [支持] | [支持] | [不支持] |

- **级联跳板机拓扑**：支持任意深度的多级 SSH 链式跳转，系统自动在各层中间节点建立动态转发代理与隧道保活机制。
- **Telnet 路由实现**：Telnet 会话统一接入服务端的 `createRoutedTcpForward`，支持原始 TCP 流经由 SOCKS5/HTTP 代理或 SSH 跳板链（`direct-tcpip`）穿透访问。Telnet 目标支持静态加密的带内用户名/密码自动登录，但 Telnet 连接本身不能充当中间跳板机。
- **RDP 跳板访问链路**：浏览器 WASM RDP 客户端 -> WebSocket -> Zephyr Node.js 代理 -> SSH 跳板链路 -> 目标 RDP 机器:3389。
- **VNC 跳板访问链路**：浏览器 noVNC 客户端 -> WebSocket -> Zephyr VNC 代理（自动完成 VNCAuth）-> SSH 跳板链路 -> 目标 VNC 机器:5900。

---

### 快速开始与生产部署

#### Docker 标准运行

必须将宿主机的持久化数据目录挂载到容器内 `/app/data`，避免容器销毁引发数据库和加密主密钥丢失。

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请在此生成并填写32字节Base64格式的高强度随机密钥
PUBLIC_ORIGIN=https://zephyr.example.com
PORT=3000
EOF

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

浏览器访问：`http://你的服务器IP:3000`  
默认初始管理员：
- **账号**：`admin`
- **密码**：`admin`（首次成功认证后系统强制要求更改高强度密码）。

#### Docker Compose 部署

```yaml
version: '3.8'

services:
  zephyr:
    image: ghcr.io/lanlan13-14/zephyr-ssh:latest
    container_name: zephyr
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./zephyr-data:/app/data
    environment:
      - PORT=3000
      - PUBLIC_ORIGIN=https://zephyr.example.com
      - ENCRYPTION_KEY=请在此生成并填写32字节Base64格式的高强度随机密钥
```

#### 环境参数配置表

| 变量名称 | 作用说明 | 默认值 |
|---|---|---|
| `PORT` | Web 界面与 HTTP API 监听端口 | `3000` |
| `PUBLIC_ORIGIN` | 服务的公开访问域名（Passkey / WebAuthn 校验依赖） | 生产环境必填 |
| `ENCRYPTION_KEY` | 静态凭据信封加密的主密钥（32 字节高熵随机值） | 必填 |
| `ZEPHYR_DATA_DIR` | 容器内持久化数据挂载绝对路径 | `/app/data` |
| `ZEPHYR_AI_LISTEN` | 内置 Go AI 核心的本地回环监听地址 | `127.0.0.1:8450` |
| `ZEPHYR_AI_URL` | Node 主端向内部 Go AI 核心通信的反代目标 | `http://127.0.0.1:8450` |
| `HTTPS_CERT_FILE` | 自定义 TLS 证书绝对路径（可选） | 空 |
| `HTTPS_KEY_FILE` | 自定义 TLS 私钥绝对路径（可选） | 空 |

#### 持久化存储与镜像更新

在保持现有配置和数据完整的前提下更新服务版本：

```bash
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest
docker stop zephyr-ssh
docker rm zephyr-ssh
# 重新执行初始 docker run 命令，确保宿主机目录挂载保持为 -v "$(pwd)/zephyr-data:/app/data"
```

---

### 从源码构建

#### 环境准备
- Node.js >= 20.x, npm >= 10.x
- Go >= 1.26
- GCC / Clang / Make 构建工具链
- Bubblewrap, ImageMagick, Chromium 依赖

#### 构建步骤

```bash
# 1. 安装 Node.js 运行时依赖
npm ci

# 2. 编译 RDP 前端 Go WASM 二进制
cd rdp-wasm
go mod tidy
GOOS=js GOARCH=wasm go build -o ../public/vendor/rdp-wasm/main.wasm .
cd ..

# 3. 构建前端终端与 Monaco 编辑器打包资源
npm run build:terminal
npm run build:editor

# 4. 编译 AI 智能体调度核心与 Link 传输二进制
cd zephyr-ai && go build -o /usr/local/bin/zephyr-ai ./cmd/zephyr-ai && cd ..
cd zephyr-link && go build -o /usr/local/bin/zephyr-link-server ./cmd/zephyr-link-server && cd ..

# 5. 启动服务
npm start
```

---

### 代码仓库目录结构

```text
.
+-- server.js               # Node.js 主服务入口与 HTTP/WS 反向路由
+-- ai-*.js                 # Node 侧 AI 工具编排、会话持久化与策略控制
+-- link-v2-*.js            # Zephyr Link 传输代理与设备绑定管理
+-- mobile-v1-*.js          # 移动端同步通道、实体仓库与加解密桥接
+-- public/                 # 静态 Web 资产、交互页面与样式表
|   +-- app.html / app.js   # 运维工作台单页应用核心
|   +-- terminal.*          # 基于 DOM 渲染的高保真 WebSSH 交互页面 (@wterm/dom)
|   +-- rdp.*               # WebCodecs + WebGL2 WASM 远程桌面页面
|   +-- vendor/             # 预构建前端依赖库 (wterm, xterm, monaco 等)
+-- zephyr-ai/              # Go 语言编写的 AI Agent Loop、MCP 工具与运行时
+-- zephyr-cell/            # Go 语言 Linux 沙箱执行框架 (bwrap / 命名空间)
+-- zephyr-link/            # Go 语言 ZSL/2 后量子应用层加密协议核心与隧道 Hub
+-- zephyr-worker/          # Go 语言持久 PTY 会话监管与增量流分发服务
+-- zephyr_one/             # 第一方客户端集合
|   +-- electron/           # Desktop One Electron 主进程与生命周期管理
|   +-- src/                # Desktop One 界面实现代码 (Vite)
|   +-- mobile/android/     # Android One 原生端 (Kotlin, Jetpack Compose, AGSL)
|   +-- mobile/ios/         # iOS One 原生端 (Swift, SwiftUI, Keychain)
+-- zephyr_agent/           # 边缘主机反向穿透与虚拟磁盘映射守护进程 (Flutter)
+-- rdp-wasm/               # Go WASM RDP 客户端实现与定制打补丁的 grdp 引擎
+-- Dockerfile              # 多阶段容器化构建镜像蓝图
```

---

### 安全合规建议

1. **凭据安全初始重置**：首次完成安装后，务必立即替换默认超级管理员密码。
2. **根密钥灾备存储**：妥善离线备份 `data/crypto/ml-kem-768-keypair.json`。该密钥对是解开所有已保存密码和私钥的唯一根源，一旦遗失将造成不可逆的数据损坏。
3. **前置反向代理**：严禁将 Zephyr 原生 HTTP 端口直接暴露于公网，生产环境必须置于配置了标准 TLS 1.3 证书的专业反向代理（如 Nginx、Caddy）后方。
4. **管理网段限制**：生产部署强烈推荐开启内置的 IP 白名单拦截，仅允许运维专用内网网段访问管理页面。
5. **构建物锁定**：严格提交并锁定 `package-lock.json` 与 `go.sum`，抵御供应链投毒与依赖漂移。

---

### 赞助商与致谢

诚挚感谢 **[LightCone](https://www.lightcone.hk/)** 为本项目提供的持续赞助与技术支持。

致敬为本项目提供技术基石的优秀上游开源生态：
- [wterm](https://github.com/vercel-labs/wterm)
- [ssh2](https://github.com/mscdex/ssh2)
- [SimpleWebAuthn](https://simplewebauthn.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

### 开源许可证

Zephyr 基于 **GNU General Public License v3.0** ([GPL-3.0](LICENSE)) 协议开源。