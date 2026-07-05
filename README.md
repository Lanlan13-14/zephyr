# 🌬️ Zephyr-SSH

> Zephyr-SSH 是一个基于 Node.js 的浏览器服务器管理平台，提供 WebSSH 终端、SSH / RDP / VNC 连接管理、SSH 跳板与代理路由、安全登录、多因素认证、远程批量执行、数据备份导入导出等能力。


---

## 目录

- [功能特性](#功能特性)
- [协议与路由能力](#协议与路由能力)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [AI 助理智能体](#ai-助理智能体)
- [RDP / VNC / noVNC](#rdp--vnc--novnc)
- [Docker Compose 部署](#docker-compose-部署)
- [Docker 自行构建](#docker-自行构建)
- [更新容器并保留数据](#更新容器并保留数据)
- [项目结构](#项目结构)
- [安全建议](#安全建议)
- [依赖与数据说明](#依赖与数据说明)
- [计划](#计划)
- [致谢](#致谢)

---

## 功能特性

### 连接与终端

- 🖥️ **WebSSH 终端**：基于 `ssh2` + WebSocket，在浏览器中打开 SSH Shell。
- 🌊 **DOM 终端渲染**：基于 `@wterm/dom`，终端文本可像普通网页一样拖选复制。
- 📱 **移动端友好**：支持移动端长按、拖拽选择和系统复制菜单。
- 🗂️ **连接资产管理**：支持 SSH / RDP / VNC 连接管理、搜索、排序、标签和备注。
- 🖥️ **RDP / VNC 远程桌面**：RDP 使用纯 Go WASM 方案（grdp），全部协议处理和渲染在浏览器端完成——不依赖服务端 FreeRDP、Python 或任何 native 组件。支持 H.264 WebCodecs 硬解、Canvas 2D 位图渲染、RDPGFX/RemoteFX Progressive、画质/FPS/分辨率（PPI 档位：1080p/2K/4K/8K/自动）、移动端软键盘（含 IME 中文输入）、快捷键、视区摇杆（速度模式无限平移）、浮窗布局菜单（全屏/半屏/四分之一/关闭）、双指滚动缩放、剪贴板双向同步、跨标签文件传输。VNC 使用内置 noVNC 页面和 Zephyr WebSocket 代理。
- 🧭 **代理与跳板路由**：支持 SOCKS5 / HTTP CONNECT 代理、SSH 跳板机和多级 SSH 跳板链路。
- ⚡ **远程批量执行**：可对多个 SSH 连接批量执行命令并查看结果。
- 🧰 **远程运维能力**：支持远程状态监控、Docker 容器/镜像查看、日志查看、镜像拉取等 SSH 运维操作。
- 🤖 **AI 助理智能体**：可在设置中启用独立 AI 助理入口，支持多模型供应商、自定义 API Base URL、模型参数、逐模型请求 User-Agent、Skills、内置 Chromium 浏览器自动化与截图嵌入预览、按连接/项目/标签关联的长期 Memory、可暂停/继续/重试的任务规划器、AI 专用加密环境变量、远程命令执行、远程文件读写、敏感操作确认和编辑器 AI 代码补全。
- 🖼️ **图片类文件预览**：文件管理器支持图片预览，前端使用 Viewer.js 负责缩放/拖动/全屏，后端 Preview API 对浏览器不支持的 HEIC/TIFF/PSD/RAW/DDS/HDR 等格式通过 Sharp 优先、ImageMagick 兜底转为 WebP。
- 🎨 **个性化终端**：设置页支持品牌名/图标、主题、自定义 CSS/JS、SSH 终端背景图与背景强度、自定义深色/浅色终端字体颜色；浅色字体未填写时会自动使用深色字体的反色。
- 📋 **跨会话文件剪贴板**：支持本机 ↔ RDP、SSH ↔ RDP、RDP ↔ SSH、RDP ↔ RDP 的文件剪贴板桥接；RDP 侧使用 Windows 原生 CLIPRDR 文件剪贴板语义，远端 Ctrl+V 时按需拉取文件内容。

### 安全与账号

- 🔐 **安全登录体系**：默认管理员、首次登录强制改密、登录会话、密码修改。
- 🧩 **MFA 多因素认证**：支持 TOTP 动态验证码与 Passkey / WebAuthn。
- 🛡️ **登录防护**：支持 CAPTCHA、人机验证、登录失败记录、IP 防爆破封禁、IP 白名单。
- ✉️ **邮件通知**：支持 SMTP 测试邮件、登录成功/失败通知、忘记密码邮箱验证码重置。
- 🧾 **备案信息**：支持 ICP / 公安备案信息配置与登录页展示。

### 数据与部署

- 💾 **SQLite 数据存储**：使用 `better-sqlite3` 持久化用户、连接、设置、安全事件等数据。
- 🔐 **敏感数据加密**：连接密码/私钥、代理密码、SSH 密钥、TOTP Secret、SMTP/CAPTCHA 密钥等字段使用 ML-KEM-768 + AES-256-GCM 混合加密后落盘。
- 📦 **数据备份**：支持加密备份导出、备份导入，并在导入前自动生成本地数据库备份。
- 🐳 **Docker 部署**：Docker 镜像内置 Node.js 运行时和 noVNC 所需运行依赖，RDP 使用浏览器端 Go WASM 无需服务端 native 组件，可直接部署使用。

---

## 协议与路由能力

| 协议 | 作为目标连接 | 可通过代理访问 | 可通过 SSH 跳板访问 | 可作为跳板机 |
| --- | --- | --- | --- | --- |
| `SSH` | ✅ | ✅ | ✅ | ✅ |
| `RDP` | ✅ | ✅ | ✅ | ❌ |
| `VNC` | ✅ | ✅ | ✅ | ❌ |

说明：

- **SSH** 既可以作为目标连接，也可以作为跳板机。
- **RDP / VNC** 可以作为目标连接，并且可以通过 SSH 跳板链路访问。
- **RDP / VNC 不能作为跳板机**。跳板机只能选择 SSH 连接。
- RDP / VNC 通过跳板访问时，Zephyr 会在服务端建立临时链路：RDP 由 Node.js WebSocket→TCP 代理将浏览器 WASM grdp 客户端的流量转发到目标 RDP 端口，VNC 由 Zephyr 的 noVNC WebSocket 代理直接完成 VNC 握手与转发。

RDP 经 SSH 跳板访问链路：

```text
浏览器 (Go WASM grdp)
  ── WebSocket ──► Zephyr Node.js /rdp-proxy
  ── TCP ──► SSH 跳板链路
  ──► 目标 RDP 主机:3389
```

VNC 经 SSH 跳板访问链路：

```text
浏览器 noVNC
  -> Zephyr /novnc WebSocket
  -> Zephyr VNC 代理（服务端完成 VNCAuth）
  -> SSH 跳板链路或代理
  -> 目标 VNC 主机
```

---

## 快速开始

### 方式一：Docker 镜像运行

> 生产部署请务必持久化 `/app/data`，并提前准备 `.env`。

Zephyr 的 SQLite 数据库、运行配置和备份文件都在容器内 `/app/data`。如果没有挂载该目录，删除或重建容器会导致数据丢失。

推荐使用宿主机目录挂载：

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
EOF

docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

访问：

```text
http://your-server-ip:3000
```

默认账号：

```text
用户名：admin
密码：admin
```

首次登录后系统会要求修改默认密码。

### 方式二：本地开发运行

```bash
npm install
npm start
```

浏览器访问：

```text
http://localhost:3000
```

本地开发运行 RDP 时，需要 Go 1.26+ 编译 `rdp-wasm/` 为 WASM（`GOOS=js GOARCH=wasm go build -o public/vendor/rdp-wasm/main.wasm .`）。Docker 镜像会在构建阶段自动完成编译。

---

## 配置说明

Zephyr 会读取 `data/.env`，也可以通过 Docker `--env-file` 注入环境变量。

生产环境建议提前准备：

```env
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
HTTPS_PORT=3443
# 可选：挂载自有证书；未设置时 Zephyr 会自动生成 data/https/zephyr.{key,crt}
# HTTPS_CERT_FILE=/app/data/https/fullchain.pem
# HTTPS_KEY_FILE=/app/data/https/privkey.pem
```

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `HTTP_ENABLED` | 是否启用明文 HTTP 服务；默认禁用，建议仅调试或可信内网临时开启 | `false` |
| `PORT` | HTTP Web 服务监听端口；仅 `HTTP_ENABLED=true` 时生效 | `3000` |
| `HTTPS_ENABLED` | 是否启用内置 HTTPS 服务；RDP/WebCodecs 建议保持开启 | `true` |
| `HTTPS_PORT` / `ZEPHYR_HTTPS_PORT` | 内置 HTTPS 服务监听端口；Docker 默认暴露 `3443` | `3443` |
| `HTTPS_CERT_FILE` / `SSL_CERT_FILE` | 可选：自有 TLS 证书路径；未设置时自动生成自签证书到 `data/https/zephyr.crt` | `data/https/zephyr.crt` |
| `HTTPS_KEY_FILE` / `SSL_KEY_FILE` | 可选：自有 TLS 私钥路径；未设置时自动生成自签私钥到 `data/https/zephyr.key` | `data/https/zephyr.key` |
| `HTTPS_CERT_CN` / `PUBLIC_HOST` | 自动自签证书的 CN；SAN 会自动包含本机局域网 IPv4、`localhost`、`127.0.0.1`，也可用 `HTTPS_CERT_ALT_NAMES` 追加 | `localhost` |
| `ENCRYPTION_KEY` | 备份导出/导入加密密钥，生产环境必须改为强随机字符串 | `please-change-this-key` |
| `ZEPHYR_DATA_MLKEM768_PUBLIC_KEY_B64` / `ZEPHYR_DATA_MLKEM768_SECRET_KEY_B64` | 可选：外部注入 ML-KEM-768 数据字段加密密钥对；未设置时会自动生成到 `data/crypto/ml-kem-768-keypair.json` | 自动生成 |
| `ZEPHYR_DATA_MLKEM768_KEY_FILE` | 可选：自动生成/读取 ML-KEM-768 数据字段加密密钥文件路径 | `data/crypto/ml-kem-768-keypair.json` |
| `PUBLIC_ORIGIN` | Passkey / WebAuthn 使用的固定站点来源，也用于同源校验和 HTTPS Cookie 判断；应与浏览器访问地址一致 | `http://localhost:3000` |
| `TRUST_PROXY` / `ZEPHYR_TRUST_PROXY` | 是否信任反向代理传入的 `X-Forwarded-For` / `X-Forwarded-Proto`；只有 Zephyr 仅暴露在可信 Nginx/Caddy 后方时才设为 `true` | `false` |
| `SESSION_TTL_SECONDS` | 普通登录会话服务端有效期 | `86400` |
| `REMEMBER_SESSION_TTL_SECONDS` | “记住我”会话服务端有效期 | `2592000` |
| `ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN` | 是否允许默认密码账号从公网 IP 登录；生产环境不要开启 | `false` |

注意：

- RDP GFX 的 H.264/WebCodecs、Canvas、音频播放等能力在现代浏览器中体验最好，建议通过 HTTPS 访问（内置 HTTPS 默认开启）；HTTP 或未被浏览器信任的自签证书环境可能影响 WebCodecs、剪贴板、音频自动播放等浏览器能力。
- 使用 Passkey / WebAuthn 时，生产环境建议启用 HTTPS。
- `PUBLIC_ORIGIN` 必须与实际访问地址一致，例如 `https://ssh.example.com`。生产环境配置为 HTTPS 后，登录 Cookie 会自动带 `Secure`。
- Zephyr 会校验非 GET 请求的 `Origin` / `Referer` 与 `PUBLIC_ORIGIN` 同源，反代后的公开域名、协议配置不一致会导致写操作返回 403。
- `ENCRYPTION_KEY` 用于加密备份文件。旧备份需要使用导出时的旧密钥才能解密导入。
- Zephyr 首次启动会生成 ML-KEM-768 数据字段加密密钥对，默认保存在 `data/crypto/ml-kem-768-keypair.json`。数据库内的敏感字段会使用该密钥派生的混合加密方案落盘；迁移、备份或恢复时必须同时保留该密钥文件，或通过 `ZEPHYR_DATA_MLKEM768_PUBLIC_KEY_B64` / `ZEPHYR_DATA_MLKEM768_SECRET_KEY_B64` 外部注入同一密钥对。使用默认文件密钥时，后台导出的 `.zip.enc` 备份会把该密钥文件一起放入 `ENCRYPTION_KEY` 加密包中，便于跨机器恢复。
- 程序首次启动如果发现 `data/.env` 不存在，会生成默认占位文件；生产环境不要长期使用默认密钥。

---

## AI 助理智能体

Zephyr 内置可选 AI Agent 能力，默认关闭。登录后台后进入 **设置 → AI 助理** 可启用：

- **多模型供应商**：支持 OpenAI 兼容接口、Anthropic Claude、Google Gemini；可配置自定义 API Base URL、API Key、模型列表、默认模型、上下文窗口/最大输入长度、逐模型请求 User-Agent、额外请求头和常见模型参数（temperature、top_p、max_tokens/max_output_tokens、presence/frequency penalty、reasoning_effort、额外 JSON 参数等）。逐模型 User-Agent 以 `模型名=User-Agent` 形式配置，只对聊天/生成请求中精确匹配的模型生效；未配置的模型保持默认请求头。`auto` 默认按 Chat Completions 兼容路径发送，只有明确选择 Responses API 或 Base URL 以 `/responses` 结尾时才使用 Responses；`previous_response_id` 默认关闭，避免兼容网关报错。高轮次对话会自动做上下文压缩：早期轮次合并为摘要注入系统提示，最近消息保持原文，避免请求体随轮次线性膨胀导致响应变慢、超时或上游模型报错；这不是限制对话轮次。Zephyr 内置默认系统提示词，约束 AI 按当前连接、标签、备注、Memory、计划器和敏感确认流程工作。
- **独立入口与浮窗**：启用后顶部 AI 按钮会打开类似 SSH 文件/监控面板的浮窗；桌面端支持拖拽、缩放和布局，移动端优化为稳定的全屏/近全屏面板，保留顶部整条标题栏拖动、横向对话切换和内部滚动，避免浮窗导致页面无法滑动或画面消失。
- **工具权限与透明过程**：可单独开关网页搜索、网页正文读取、内置 Chromium 浏览器自动化、远程执行、远程文件读取、远程文件写入、代码编辑/补全、长期 Memory 和 AI 环境变量。AI 还能列出/新增/修改/删除连接、代理、SSH 密钥库、跳板机和代码片段，测试 SSH/RDP/VNC 连通性，读取当前 SSH 终端屏幕/scrollback 输出，读取 RDP/VNC 远程桌面画面快照，并通过 `ui_action` 在当前 Zephyr 页面可见地切换视图、打开连接弹窗、排列终端窗口、点击 SSH 终端工具栏，或直接调整 RDP/VNC 工具栏（画质、视图/适应、缩放、剪贴板、软键盘、快捷键、视区/拖拽、Ctrl+Alt+Del、重连/断开、发送文本/快捷键/坐标点击）。AI 每次工具调用会在聊天中生成独立过程卡片，展示工具、参数摘要、耗时、结果摘要和可展开的完整参数/结果；敏感字段仍会打码。RDP/VNC 画面截图在支持视觉输入的模型供应商上会以多模态图片传给模型（Anthropic/Gemini/OpenAI 均支持）。
- **内置 Chromium 浏览器自动化**：Docker 运行镜像内置 `chromium`，AI 可通过 CDP 执行页面导航、截图、点击、输入、滚动和正文读取；每次浏览器工具调用会返回 `/api/ai/browser/screenshots/...` 预览，AI 浮窗会把截图直接嵌入聊天流和顶部浏览器预览区。默认每个 Zephyr 进程使用独立运行 profile（`data/ai-browser/profile/runtime-<host>-<pid>`），避免容器重启、滚动更新或旧 Chromium 残留时触发 `profile appears to be in use` 锁冲突；如确实要多个进程共用同一个 profile，可设置 `AI_CHROMIUM_PROFILE_SHARED=true`，但不推荐。
- **长期 Memory / 项目记忆**：可在设置页维护项目约定、服务器规则、用户偏好，也可由 AI 通过 `memory_save` 工具写入、`memory_search` 工具检索；Memory 支持按 SSH 连接 ID、项目/Scope、标签自动关联和排序，而不是只靠全文搜索。
- **任务规划器**：AI 可用 `plan_task` 为复杂任务生成步骤、风险和状态，设置页会展示最近计划；后续可通过 `plan_update` 更新步骤状态、暂停/继续计划、标记失败并重试失败步骤，也可通过设置页按钮或 `plan_delete` 删除计划。
- **AI 专用环境变量**：可在设置页保存加密变量，AI 默认只看到变量名；读取值必须调用 `get_env_var`，并触发敏感操作确认或自动确认延迟。
- **敏感操作确认**：远程执行、远程写文件、读取 AI 环境变量默认需要用户在 AI 浮窗内手动确认；也可在设置中开启自动确认并设置延迟。
- **Skills**：可在设置页添加/启用多个 Skill，把工作流、角色设定、工具使用规则和专用提示词注入 AI 上下文；Zephyr 会默认内置一个本地运维 Skill，让模型优先理解连接资产、当前终端上下文、远程文件/命令、Memory 和敏感确认流程。
- **编辑器 AI 补全**：SSH 文件管理器的代码编辑器支持 `Ctrl/⌘ + Shift + Space`、命令面板“AI 代码补全”、顶部“AI补全”按钮和移动端工具栏 `AI` 按钮。
- **性能监控基线**：服务端会记录最近 AI 请求的总耗时、模型供应商耗时、工具耗时、工具调用数量、上下文压缩条数等内存样本，可通过登录后的 `GET /api/ai/metrics` 查看。该接口用于压测和线上排障，不返回 API Key、环境变量值、密码、私钥等敏感内容。

API Key、AI 环境变量等密钥会作为设置敏感字段使用 ML-KEM-768 + AES-256-GCM 混合加密后保存；前端读取设置时只返回 `******` 占位。需要再次查看 AI Provider API Key 时，可在模型供应商列表点击“查看 Key”，流程复用已保存密码查看逻辑：开启 TOTP 时输入动态验证码，否则输入当前登录密码。

### Skill 怎么写

Skill 不是插件代码，而是一段会被注入 AI 上下文的“操作规程 / 工具说明书”。适合把固定工作流、项目约定、服务器规则、工具调用顺序写清楚，让模型少猜、少摸索。

建议一个 Skill 按下面结构写：

```md
# Skill 名称

## 适用场景
- 用户提到哪些关键词/任务时使用这个 Skill。
- 不适用什么场景，避免模型误用。

## 必须先确认的上下文
- 当前连接 / 项目 / 标签怎么选。
- 需要先调用哪些只读工具，例如 list_connections、list_zephyr_resources、memory_search、remote_read_file。

## 工具调用流程
1. 第一步调用什么工具，拿什么字段。
2. 第二步如何根据结果分支。
3. 修改类操作用哪些工具，哪些操作必须等待敏感确认。

## 安全规则
- 不复述密码、私钥、Token。
- 删除 / 重启 / 写文件 / 执行命令前说明对象和风险。
- 远程命令避免 top、vim、less、tail -f、watch 等交互/无界命令。

## 输出格式
- 已执行：列动作和结果。
- 需要确认：列目标、命令/文件、风险。
- 失败：列证据、原因、下一步。
```

Zephyr 自带的默认 Skill 已经写入了本地运维常用规则，重点包括：

- **连接选择**：先 `list_connections` / `list_zephyr_resources`，按名称、Host、标签、备注匹配，不让用户手动复制 ID。
- **本地资源管理**：连接用 `connection_create/update/delete/test`，代理用 `proxy_save/delete`，SSH 密钥用 `ssh_key_save/delete`，跳板机用 `jump_host_save/delete`，代码片段用 `snippet_save/delete`。
- **当前页面 UI 代操作**：Zephyr 自身页面不要再用浏览器 DOM 自动化摸索，优先用 `ui_action`；打开 SSH/RDP/VNC 会话优先用 `open_connection`；RDP/VNC 画质、视图、缩放、剪贴板、软键盘、快捷键、Ctrl+Alt+Del、重连/断开和坐标点击也走 `ui_action` 的远程桌面动作。
- **终端操作**：后台批量命令优先 `remote_execute`；读取当前 SSH 终端屏幕/scrollback 输出用 `terminal_read_output`，也会自动带入当前终端输出快照；如果用户明确要“在当前终端可见输入”，才用 `ui_action({ action:'terminal_send_input', run:false/true })`，其中 `run:true` 会触发敏感确认。
- **远程运维**：RDP/VNC 只能打开会话或测试连通性，不能当 SSH 执行命令；SSH 修改前尽量备份，修改后验证。
- **Memory**：长期记忆要带 `connectionIds`、`project/scope`、`tags`，不要只写一段散文。

一个面向具体项目的 Skill 示例：

```md
# Zephyr 项目部署 Skill

## 适用场景
用户提到“部署 Zephyr / 更新 Zephyr / 检查 Zephyr 服务”时使用。

## 上下文选择
- 先 list_connections，优先选择 tags 包含 zephyr、prod、server 的 SSH 连接。
- 再 memory_search，query 使用 zephyr deploy，connectionIds 使用当前连接。

## 流程
1. 用 remote_execute 查看当前目录、git 分支、服务管理方式：pwd; git status --short; docker ps; systemctl status zephyr --no-pager。
2. 如果要改代码，先确认分支和未提交内容；不要直接覆盖用户改动。
3. 部署前创建计划 plan_task，列出 pull/build/restart/verify。
4. 重启或写文件属于敏感操作，等待用户确认。
5. 完成后用 curl / health check / docker logs --tail 80 验证。

## 输出
- 先说当前版本、目标版本、服务状态。
- 再列已执行命令和验证结果。
- 失败时给下一步，不要重复盲跑。
```

写 Skill 时尽量写“何时用、先查什么、调用哪个工具、失败怎么处理”，少写抽象人格描述。不要把 API Key、密码、私钥直接写进 Skill；密钥应放在 AI 环境变量或连接/密钥库里，由工具按敏感确认流程读取。

---

## RDP / VNC / noVNC

RDP 和 VNC 都不需要把目标端口暴露到公网，浏览器只连接 Zephyr：

- **RDP**：使用纯 **Go WASM (grdp)** 方案。所有 RDP 协议处理（NLA/CredSSP 认证、TPKT/MCS/SEC 协议栈、RDPGFX/RemoteFX Progressive 图形管线、CLIPRDR 剪贴板、RDPSND 音频、RDPDR 虚拟驱动器、RDPECAM 摄像头、MS-RDPEL 位置、MS-AUDIN 麦克风）和渲染全部在浏览器端完成，服务端只提供 WebSocket→TCP 代理（`/rdp-proxy`）。
  - **架构**：`rdp-wasm/` 目录下的 Go 源码编译为 `main.wasm`（Dockerfile Stage 2 自动用 `golang:1.26-alpine` 构建），浏览器加载后通过 `rdp-wasm-client.js` 驱动连接、渲染和用户交互。
  - **图形渲染**：H.264 帧通过 WebCodecs `VideoDecoder` 硬解并 `drawImage` 到 Canvas；位图通过 `putImageData` 直接绘制（`desynchronized:true` 跳过合成器延迟）；Go 侧复用渲染缓冲区避免重复分配。
  - **每连接设置**：每个 RDP 连接可独立配置分辨率（PPI 档位：1080p/2K/4K/8K/自动）、画质（平衡/性能/画质）、帧率（30/45/60/120/144 FPS）；默认平衡+1080p+30FPS。分辨率档位按屏幕容器实际宽高比计算远程分辨率（不是固定 16:9），适应模式零黑边。
  - **文件传输**：上传文件到远程（CLIPRDR FileGroupDescriptorW + FileContents 协议，Windows 右键粘贴触发按需拉取）、从远程下载文件（异步 4MB 分块 FILECONTENTS_RANGE）、RDPDR 虚拟驱动器（`\\tsclient\WEBRDP`）。
  - **跨标签文件桥接**：SSH ↔ RDP 双向文件传输通过服务端临时文件中转（`/api/clipboard/upload` + `/api/clipboard/download/:token`，流式传输，无大小限制）；复制时只发元数据，粘贴时才拉取真实数据。
  - **剪贴板**：文本剪贴板双向同步（CF_UNICODETEXT）；文件剪贴板支持 Windows 复制文件→浏览器下载、浏览器上传→Windows 粘贴。
  - **移动端**：软键盘支持退格/删除/回车 + IME 中文输入（通过剪贴板粘贴注入）；双指上下/左右滚动（屏幕像素计算）；双指缩放。
  - **连接稳定性**：12 秒连接看门狗、300ms 断开间隔防竞态、AudioContext 复用、重连互斥锁防循环。
  - **壁纸与动效**：平衡+画质模式启用壁纸和桌面动效（清除 PERF_DISABLE_WALLPAPER/FULLWINDOWDRAG/MENUANIMATIONS/THEMING），仅性能模式禁用。
- **VNC**：使用内置 **noVNC** 前端，浏览器通过 `/novnc` WebSocket 连接 Zephyr；Zephyr 在服务端直连/代理/SSH 跳板到目标 VNC Server，并在服务端使用保存的 VNC 密码完成 VNCAuth，密码不会下发到浏览器。

### Docker 镜像内置运行依赖

项目 Docker 镜像运行层基于 Alpine，已包含：

- Node.js 运行时
- Go WASM RDP 客户端（`main.wasm`，Dockerfile 构建阶段用 `golang:1.26-alpine` 从 `rdp-wasm/` 源码编译）
- noVNC 前端依赖

RDP 不需要服务端 native 组件（无 FreeRDP、无 Python bridge、无 libwebp/FFmpeg/Opus 依赖）。所有 RDP 协议处理在浏览器 WASM 中完成。

### RDP 相关说明

| 项目 | 说明 |
| --- | --- |
| RDP 协议栈 | 纯 Go WASM (grdp fork)，浏览器端运行 |
| 服务端代理 | Node.js `/rdp-proxy` WebSocket→TCP 代理 |
| 图形渲染 | H.264 WebCodecs + Canvas 2D `putImageData` |
| 剪贴板 | MS-RDPECLIP (CLIPRDR) 文本 + 文件双向 |
| 音频 | RDPSND PCM → Web Audio API |
| 虚拟驱动器 | MS-RDPEFS (RDPDR) `\\tsclient\WEBRDP` |
| 分辨率模型 | PPI 档位（1080p/2K/4K/8K），宽高比跟随屏幕 |
| 跨标签文件中转 | `/api/clipboard/upload` + `/api/clipboard/download/:token` 流式 |

### 默认端口

| 协议 | 默认端口 | 说明 |
| --- | --- | --- |
| `SSH` | `22` | WebSSH 终端 |
| `RDP` | `3389` | Windows 远程桌面，经浏览器 Go WASM grdp + Zephyr `/rdp-proxy` WebSocket→TCP 代理 |
| `VNC` | `5900` | VNC Server，经 noVNC + Zephyr `/novnc` 代理 |

### RDP/VNC 使用跳板

RDP/VNC 本身不是 SSH 协议，也不能作为 SSH 跳板机；但 Zephyr 支持通过 SSH 跳板链路访问 RDP/VNC 目标端口。

配置方式：

1. 先创建一个 SSH 连接，作为跳板机。
2. 在“网络 / 跳板机”中创建跳板机配置，并选择该 SSH 连接。
3. 创建或编辑 RDP/VNC 连接。
4. 在高级路由中选择“跳板机”，选择刚才创建的 SSH 跳板机。
5. 保存并测试连接。

限制说明：

- 跳板机候选项只会显示 SSH 连接。
- RDP/VNC 不能被选为跳板机。
- RDP/VNC 可以作为最终目标，通过 SSH 跳板访问。
- 多级跳板中的每一级都必须是 SSH 连接。

### 常见排查

RDP：

- Windows 是否已开启“远程桌面”。
- Windows 防火墙或云安全组是否允许访问 `3389`。
- 账号是否允许远程桌面登录。
- 如果使用自签名证书，Zephyr 默认设置 `ignore-cert=true`。

VNC：

- 目标主机是否已启动 VNC Server。
- VNC 端口是否为 `5900` 或配置中的自定义端口。
- VNC 密码是否正确。
- Zephyr noVNC 代理当前支持标准 VNC `None` / `VNCAuth` 安全类型；RealVNC/VeNCrypt/RA2 等专有安全类型可能需要在 VNC Server 侧切换兼容模式。
- 防火墙或安全组是否允许 Zephyr 服务端访问对应端口。

服务端日志关键字：

```text
[rdp-wasm]
[rdp-proxy]
[cliprdr]
[rdpefs]
[novnc-ws]
[novnc-test]
[tcp-forward]
[route-plan]
```

---

## Docker Compose 部署

Docker Compose 适合长期部署和后续升级维护。下面示例使用官方镜像，并把运行数据持久化到宿主机 `./zephyr-data` 目录。

### 1. 准备数据目录和环境变量

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
EOF
```

配置说明：

- `ENCRYPTION_KEY`：生产环境必须改成强随机字符串，用于加密备份文件。
- `PUBLIC_ORIGIN`：必须改成用户实际访问地址；如果通过域名和 HTTPS 访问，应填写 `https://你的域名`。
- `PORT`：容器内 Web 服务监听端口，通常保持 `3000`。

### 2. 创建 compose.yaml

在部署目录创建 `compose.yaml`：

```yaml
services:
  zephyr-ssh:
    image: ghcr.io/lanlan13-14/zephyr-ssh:latest
    container_name: zephyr-ssh
    restart: unless-stopped
    env_file:
      - ./zephyr-data/.env
    ports:
      - "3000:3000"
    volumes:
      - ./zephyr-data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

> Docker 镜像已内置 Go WASM RDP 客户端和 noVNC 前端依赖；RDP 协议处理完全在浏览器端完成，服务端只提供 WebSocket→TCP 代理；VNC 走 noVNC + Zephyr `/novnc` 代理，不需要额外启动远程桌面网关容器。

### 3. 启动服务

```bash
docker compose up -d
```

查看容器状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f zephyr-ssh
```

访问：

```text
http://your-server-ip:3000
```

默认账号：

```text
用户名：admin
密码：admin
```

首次登录后系统会要求修改默认密码。

### 4. 停止、重启和删除容器

停止服务：

```bash
docker compose stop
```

重启服务：

```bash
docker compose restart
```

删除容器但保留数据：

```bash
docker compose down
```

`./zephyr-data` 中的数据不会因为 `docker compose down` 被删除。不要删除该目录，否则会丢失数据库、配置和备份文件。

### 5. 升级镜像

```bash
docker compose pull
docker compose up -d
```

升级前建议先在后台导出加密备份，或备份整个 `./zephyr-data` 目录。

### 6. 使用 HTTPS 反向代理

如果通过 Nginx、Caddy、Traefik 等反向代理提供 HTTPS 访问：

1. `PUBLIC_ORIGIN` 应设置为最终浏览器访问地址，例如 `https://ssh.example.com`。
2. 反向代理必须支持 WebSocket 转发，否则 SSH 终端、RDP/VNC 远程桌面等实时连接会异常。
3. 如果需要导入较大的备份文件或上传较大数据，反向代理需要放宽请求体大小限制。
4. Passkey / WebAuthn 建议在 HTTPS 环境下使用。

Nginx 代理关键配置示例：

```nginx
# 放在 http/server/location 块均可，按实际 Nginx 配置结构调整。
# 如果需要更大的上传限制，可以继续调高，例如 1g。
client_max_body_size 512m;

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # 保留真实访问来源和协议，便于 PUBLIC_ORIGIN、审计日志和安全策略正确工作。
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # 必须转发 WebSocket Upgrade 头。
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # 长连接场景建议调大超时时间，避免 SSH/RDP/VNC 会话被反向代理提前断开。
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

### 7. 使用命名卷部署（可选）

如果不想把数据目录放在当前部署目录，也可以使用 Docker 命名卷：

```yaml
services:
  zephyr-ssh:
    image: ghcr.io/lanlan13-14/zephyr-ssh:latest
    container_name: zephyr-ssh
    restart: unless-stopped
    env_file:
      - ./zephyr-data/.env
    ports:
      - "3000:3000"
    volumes:
      - zephyr-ssh-data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  zephyr-ssh-data:
```

检查数据卷：

```bash
docker volume inspect zephyr-ssh-data
```

---

## Docker 自行构建

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
EOF

docker build -t zephyr-ssh:local .

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  zephyr-ssh:local
```

Dockerfile 说明：

- 构建阶段使用 `node:20-alpine3.20` 与 `alpine:3.20`。
- 运行阶段基于 `node:20-alpine3.20`。
- 镜像内复制应用代码和生产依赖。
- 镜像内置 Go WASM RDP 客户端（构建阶段编译）和 noVNC 前端依赖；VNC 使用 noVNC + Zephyr `/novnc` 代理。
- 构建时会验证 `node`、`npm` 是否可执行，并编译 Go WASM。

---

## 更新容器并保留数据

更新时必须复用原来的数据目录或命名卷。

宿主机目录挂载方式：

```bash
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker rm -f zephyr-ssh

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

命名卷方式：

```bash
docker rm -f zephyr-ssh

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v zephyr-ssh-data:/app/data \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

检查持久化是否正确：

```bash
docker inspect zephyr-ssh --format '{{json .Mounts}}'
ls -la ./zephyr-data
docker volume inspect zephyr-ssh-data
```

---

## 项目结构

```text
zephyr-ssh/
├── public/
│   ├── index.html       # 登录页
│   ├── client.js        # 登录页逻辑
│   ├── app.html         # 管理后台页面
│   ├── app.js           # 管理后台逻辑
│   ├── terminal.html    # SSH 终端页面
│   ├── terminal.js      # SSH 终端逻辑
│   ├── preview/image/   # 图片预览前端模块（Viewer.js UI 接入与样式）
│   ├── rdp.html          # RDP 远程桌面页面（Go WASM grdp）
│   ├── rdp-wasm-client.js # RDP 前端逻辑（渲染、输入、文件、剪贴板）
│   ├── rdp-touch.js       # RDP 移动端触控（单指/双指/三指手势）
│   ├── novnc.html       # VNC noVNC 远程桌面页面
│   ├── novnc.js         # VNC noVNC 前端逻辑
│   └── style.css        # 全局样式
├── data/                # 运行数据目录
│   ├── .env             # 环境变量配置
│   ├── crypto/          # ML-KEM-768 数据字段加密密钥（必须随数据目录持久化和备份）
│   └── zephyr.db        # SQLite 数据库
├── preview/image/       # 图片预览后端模块（Sharp 转码、ImageMagick 兜底、缓存）
├── server.js            # 后端服务、API、WebSocket、协议路由
├── storage.js           # SQLite 存储层
├── stats.js             # 远程状态采集
├── rdp-wasm/            # Go WASM RDP 客户端源码
│   ├── main.go          # WASM 入口（JS↔Go 桥接）
│   ├── rdpefs.go        # MS-RDPEFS 虚拟驱动器
│   ├── grdp-patch/      # grdp fork（RDP 协议栈 + CLIPRDR 文件剪贴板）
│   ├── Makefile         # WASM 编译（GOOS=js GOARCH=wasm）
│   └── go.mod           # Go 模块（replace → ./grdp-patch）
├── package.json         # 项目依赖与脚本
├── package-lock.json    # 锁定依赖版本
├── Dockerfile           # Docker 构建文件
└── README.md            # 项目说明
```

---

## 安全建议

1. 首次登录后立即修改默认管理员密码。
2. 生产环境必须修改 `ENCRYPTION_KEY`。
3. 妥善备份 `data/crypto/ml-kem-768-keypair.json`（或外部注入的 ML-KEM-768 密钥对）；丢失后已加密的连接密码、私钥、TOTP Secret 等敏感字段无法解密。
4. 启用 Passkey / TOTP 前，确认服务器系统时间准确。
5. Passkey / WebAuthn 推荐在 HTTPS 环境下使用。
6. 开启 IP 白名单前，确认当前访问 IP 已包含在白名单内，避免误锁。
7. 不要提交 `data/.env`、`data/crypto/`、数据库文件、备份文件和真实连接凭据。
8. 不要把 Zephyr 直接暴露在不可信网络中，建议放在 HTTPS 反向代理之后。
9. 定期导出加密备份，并妥善保存备份密钥。
10. 删除或重建 Docker 容器前，确认 `/app/data` 已正确持久化。

---

## 依赖与数据说明

### 可以删除的文件

- `node_modules/`：本地依赖目录，可以删除；重新执行 `npm install` 即可恢复。

### 不建议删除的文件

- `package-lock.json`：锁定依赖版本，保证本地、CI、Docker 构建环境一致，建议提交到 Git。

### 推荐 Git 忽略项

```gitignore
node_modules/
data/.env
data/crypto/
data/*.db
data/*.db-shm
data/*.db-wal
data/*.enc
```

---

## 备注

阿里云验证码后端校验需要 AccessKey。当前实现支持两种方式：

1. 在后台 Secret Key 中填写：

```text
AccessKeyId:AccessKeySecret
```

2. 通过环境变量提供 `ALIYUN_ACCESS_KEY_ID`，后台 Secret Key 填写 `AccessKeySecret`。

如果仅需要最简单的webssh，使用v1.0.75即可
```bash
docker run -d \
  --name zephyr-ssh \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:v1.0.75
```

---

## 计划

1.优化终端页面布局及动画效果

2.修复单终端断开连接未自动关闭页面，且移动端未自动退出全屏的问题

3.修复切换页面或移动端键盘弹出/收起后，SSH 终端出现文字排版错乱（竖排/错位）、空白行及位移不平滑问题

4.支持文件跨终端复制粘贴

## 致谢

- [wterm](https://github.com/vercel-labs/wterm)
- [ssh2](https://github.com/mscdex/ssh2)
- [SimpleWebAuthn](https://simplewebauthn.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
