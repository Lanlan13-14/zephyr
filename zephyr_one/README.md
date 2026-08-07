# Zephyr One

Tauri 桌面客户端：**在本地运行完整 Zephyr 产品**（仪表盘 / SSH / RDP / VNC / 笔记 / AI / Client Token 等）。

平台：**Windows / macOS / Linux**。Android 与 iOS 已从本目录移除，见「为什么只有桌面」。

## 与主端的关系

| 通道 | 用途 |
| --- | --- |
| **本地嵌入核心** | 日常全部功能（`zephyr-core` = staged `server.js` + `public/`） |
| **远程 Zephyr 主端** | **仅数据同步**（`/api/one/*` 绑定与 pull），不承载日常 UI |

## 为什么只有桌面

核心是被 Tauri 拉起的 **Node 子进程**。

- **iOS**：沙箱禁止 `fork` / `exec` 任何进程，这条路不存在。
- **Android**：需要 `jniLibs/<abi>/libnode.so` + APK asset 流式喂 stdin 的一整套管线，与桌面产品并行维护不划算。

移动端将作为**原生客户端**重做（iOS SwiftUI / Android Kotlin），通过 `/api/one/*` 与主端同步，而不是把 Node 核心搬进手机。

## 本地安全（开箱）

Zephyr One **没有应用自建密码**。Web 版那套凭据墙（密码登录、强制改默认密码、TOTP、Passkey、邮箱验证码）在 embedded 模式下已整体移除：

- 核心以 `ZEPHYR_ONE_EMBEDDED=1` 启动，自动接管本地账号，不出现登录页
- 该模式同时把监听**钉死在 `127.0.0.1`** —— 自动接管只有在不可能被局域网访问时才成立
- 设置页移除「安全设置」与登出按钮（结构性移除，不是 CSS 隐藏）

真正的门禁是**系统解锁**（可选，默认 **关**）：

| 平台 | 实现 |
| --- | --- |
| Windows | Windows Hello / 设备 PIN（`UserConsentVerifier`） |
| macOS | LocalAuthentication（Touch ID / 账户密码） |
| Linux | 无统一系统 API，报告不可用 |

开启后只调**系统**认证，不收集任何应用密码。

## 版本号

发布 tag `one-v0.1.10` 必须映射到应用版本 `0.1.10`（Settings → 应用信息 / `get_app_version`）：

```bash
python3 scripts/set-version.py one-v0.1.10
# 写入 package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
# CI 三个桌面 build job 在编译前自动执行
```

## 开发

```bash
cd zephyr_one
npm install
npm run stage:desktop   # stage 完整 Zephyr → zephyr-core/ + 内置 Node → desktop-runtime/
npm run test:ci
npm run tauri dev
```

`stage:desktop` = `stage:core` + `stage-desktop-runtime.mjs`。后者把**当前 Node 可执行文件**拷进 `desktop-runtime/`，所以本地开发用的 Node 版本会进安装包。

## 目录

```
zephyr_one/
  src/                 # One 壳（可选系统解锁 / 启动本地核心）
  src-tauri/           # Tauri + 本地 runtime 拉起 Node
  zephyr-core/         # build 时 stage，不进 git
  desktop-runtime/     # build 时 stage 的 Node 可执行文件，不进 git
  platform_assets/     # 图标
  scripts/
    stage-zephyr-core.sh
    stage-desktop-runtime.mjs
    set-version.py
    prepare-icons.py
    smoke-core.sh
```
