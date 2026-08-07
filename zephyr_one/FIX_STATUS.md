# Zephyr One 修复状态（2026-08-07）

本文件记录当前真实状态，只写已验证的内容。

**Zephyr One 现在是桌面专用产品（Windows / macOS / Linux）。** Android 与 iOS 的
Tauri 实现已从仓库移除，两端将作为原生客户端（SwiftUI / Kotlin+Compose）重做，
通过主端 `/api/one/*` 同步。

## 已完成并验证

### 桌面核心不再崩溃

`POST /api/auth/change-password` 会杀掉 node 进程，WebView 只显示 `Failed to fetch`。
三个根因全部本地复现：

1. `ZEPHYR_ONE_USE_BUILTIN_SQLITE=1` 在 `runtime/mod.rs` 的**公共** env 块里，
   不是 Android 专属 —— 桌面三端一直走 `node:sqlite`，从不走 better-sqlite3。
2. `storage.updateUser()` 把整行对象传给只声明 9 个 `@` 参数的语句。
   better-sqlite3 忽略多余键，`node:sqlite` 抛 `Unknown named parameter 'createdAt'`。
3. `server.js` 没有任何 `unhandledRejection` 兜底，Express 4 不捕获 async 拒绝，
   Node 15+ 默认因此终止进程。

驱动分歧是**双向**的，实测两个驱动：

| case | `node:sqlite` 裸 | better-sqlite3 |
| --- | --- | --- |
| 多余 key | **抛错**（崩溃源） | 忽略 |
| 缺少 key | **静默写 NULL** | 抛错 |

`sqlite-driver.js` 现在解析 SQL 声明参数，过滤多余键并对缺参主动抛错，两个方向
都与 better-sqlite3 一致。参数解析器经**双 oracle**验证（裸 `node:sqlite` 抓假阳性、
better-sqlite3 抓假阴性）：全仓 199 条 `prepare()` 字面量、30 条命名语句，
假阳性 0、假阴性 0。

已接受的分歧：`node:sqlite` 返回 null-prototype 行，只有 `row.hasOwnProperty()`
会因此失败（全仓无此用法，且 eslint `no-prototype-builtins` 禁止）。规范化成本
`setPrototypeOf` +25%，故不做，改为写成断言锁定。

### Web 登录墙从 One 里移除

`ZEPHYR_ONE_EMBEDDED` 原先只用于注入 CSS，认证链完全没有 embedded 分支，
所以浏览器时代的整套凭据流程（登录、强制改默认密码、TOTP、Passkey、邮箱验证码）
在 One 里原封不动运行。现在：

- embedded 模式自动接管本地账户，`mustChangePassword=false`
- 同一模式把监听绑定钉死在 `127.0.0.1`（此前 `server.listen(PORT, resolve)`
  没有 host 参数，绑的是 `0.0.0.0`）—— 没有这一条，自动接管等于把活会话
  发给整个局域网
- `/` 直接跳 `/app.html`，不闪登录页
- 安全设置 tab 与登出按钮走 **DOM 结构移除**，不是 CSS 隐藏

顺带修掉 0.1.9 的既有 bug：`#settings-security` 是默认 active 面板，而 embed CSS
用 `display:none` 藏它，app.js 又在 3 处硬编码回退到 `[data-settings="security"]` ——
CSS 隐藏的元素照样匹配选择器，所以 One 里打开设置是**空白面板**。

### Windows 不再有黑框

`main.rs` 的 `windows_subsystem = "windows"` 只隐藏 shell 自己的 console；GUI 进程
spawn console 子系统的 node.exe 时 Windows 会另分配一个。已加
`creation_flags(CREATE_NO_WINDOW)`；stdout/stderr 早已重定向到 `zephyr-node.log`，
不丢诊断。

### 验证结果

- 22/22 端到端检查（含回归：**Web 模式仍必须登录**）
- 新增 4 个测试文件、38 个用例全绿
- 全量套件 1233 tests / 18 fail —— 与 HEAD 基线（独立 worktree 对照）**逐条相同**，
  零回归。`telnet-route` 隔离运行通过（并行 flake），`android-core-startup-smoke`
  两边同为环境前置失败

## 未验证

- **Rust 改动未本地编译**：无 rustup、无 Windows target，crate 需 1.88 而本机
  cargo 1.83。`creation_flags(&mut self, flags: u32)` 与
  `CREATE_NO_WINDOW = 0x08000000` 已对官方文档核验，真正编译验证靠 CI
  windows-2022 job。

## 已知未实现（不是 bug，是没做）

- **RDP 设置里的 Agent 存储开关是空壳。** `#rdpStorage` 每连接可独立分配、
  能落库、能传进会话参数，但 `rdp-wasm-client.js` 的 `rdpStoragePickFiles()`
  走的是浏览器 `showOpenFilePicker`，从不接触 `FileAgentManager`。
  UI 标注「需 Agent 在线」，实际与 Agent 无关。
- **文件同步按计划留空。** `store.js` 的 `fileSync` 是禁用占位。
- **One 壳的 `src/js/` 基本是死代码。** `main.js` 只 import
  `@tauri-apps/api/core`，其余 11 个模块（`agent/*` 881 行、`sync/*` 323 行、
  `settings/store.js`、`auth/unlock.js` 等）无人引用。`store.js` 的
  `requireUnlock: true` 与 `main.js` 的 `false` 冲突，因 `store.js` 是死代码，
  实际生效的是 `main.js`（默认关，符合文档）。

## 后续接手顺序

1. push 后 dispatch 桌面验证构建，确认 Windows 覆盖安装后无黑框、
   改密不再崩、设置面板非空白。
2. 决定 `#rdpStorage` 是接 `FileAgentManager` 还是改掉「需 Agent 在线」的标注。
3. 清理 `src/js/` 死代码，或明确保留原因。
