# Zephyr One

Electron 桌面客户端：**在本地运行完整 Zephyr 产品**（仪表盘 / SSH / RDP / VNC / 笔记 / AI / Zephyr Link）。

平台：**Windows / macOS / Linux**。Android 与 iOS 是独立的原生客户端，见 `zephyr_one/mobile/`。

## 与主端的关系

| 通道 | 用途 |
| --- | --- |
| **本地嵌入核心** | 日常全部功能（`zephyr-core` = staged `server.js` + `public/`） |
| **远程 Zephyr 主端** | **仅数据同步**（Zephyr Link / `/api/mobile/v1/*`），不承载日常 UI |

RDP 与 Web 端相同：WASM 客户端 + `/rdp-proxy`。Agent 跳板也与 Web 端相同。文件同步对齐 Android One：系统浏览器批准设备公钥，不收集账号密码 / TOTP / Client Token。

## 本地安全（开箱）

Zephyr One **没有应用自建密码**。Web 版那套凭据墙（密码登录、强制改默认密码、TOTP、Passkey、邮箱验证码）在 embedded 模式下已整体移除：

- 核心以 `ZEPHYR_ONE_EMBEDDED=1` 启动，自动接管本地账号，不出现登录页
- 该模式同时把监听**钉死在 `127.0.0.1`**
- 设置页移除「安全设置」里的账号墙与登出按钮（结构性移除，不是 CSS 隐藏）

真正的门禁是**系统解锁**（可选，默认 **关**）：

| 平台 | 实现 |
| --- | --- |
| Windows | Windows Hello / 设备 PIN |
| macOS | LocalAuthentication（Touch ID / 账户密码） |
| Linux | 无统一系统 API，报告不可用 |

## 开发

```bash
cd zephyr_one
npm install
npm run stage:desktop
npm run test:ci
npm run electron:dev
```

`stage:desktop` = `stage:core` + `stage-desktop-runtime.mjs`。后者把**当前 Node 可执行文件**拷进 `desktop-runtime/`。

## 目录

```
zephyr_one/
  electron/            # Electron 主进程 / preload / OS unlock / watchers
  src/                 # One 壳（可选系统解锁 / 启动本地核心）
  zephyr-core/         # build 时 stage，不进 git
  desktop-runtime/     # build 时 stage 的 Node 可执行文件，不进 git
  platform_assets/     # 图标
  scripts/
```
