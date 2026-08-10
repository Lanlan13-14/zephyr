# Zephyr One 当前现状记录

> 记录时间：2026-08-10（Asia/Singapore）。本文件是当前状态的快照，与 `FIX_STATUS.md` 的过程日志分开维护。

## 一、本次已提交（commit `cbd0c9f`，待推送）

服务端 mobile-v1（Zephyr 主端 ↔ Zephyr One 互联面）：
- 内容寻址 blob 传输，按 `SYNC_STATE_MACHINE.md` 第 11 节实现：`/api/mobile/v1/blobs/*`
  可断点续传的分块上传/下载、逐块 SHA-256 校验、owner/device 隔离、512 MiB 上限、上传 GC。
- 存储新增 `mobile_blob_uploads` + `mobile_blobs` 两张表。
- capabilities：`blobTransfer: true`；`fileBridge` 保持 `false`（设备侧 ZFT2 传输未挂载，
  契约测试钉死了这一点——之前误改成 true 导致 mobile-v1-shared 两个用例连带失败，已回退）。

桌面端（zephyr_one）：
- `scripts/stage-zephyr-core.sh`：从打包核心里只移除 RDP 的 wasm 资产
  （`vendor/rdp-wasm/` + `rdp-wasm-client.js`），其余 wasm（motion-wasm 等）保留；
  仓库自身 `public/` 不动，独立服务器仍向浏览器提供 WASM RDP。

安卓（feature-sessions）：
- `TerminalSurfaceControllerTest`：在 `scrollPages` 前先建立 scrollback
  （`transcriptRows=0` 时 `scrollBy` 被钳到 0），修复 3 个滚动用例。

## 二、当前验证状态（本地已跑）

- blob 测试：23/23 通过（`tests/mobile-v1-blobs.test.mjs` + `mobile-v1-blob-http.test.mjs`）。
- 移动契约：`mobile-v1-shared` + `schema-validation` 40/40 通过。
- 桌面 `zephyr-one.yml` 的 `test` job 此前为绿；build-linux/macos/windows 为 tag 触发，未在本分支跑。

## 三、未完成 / 已知问题（下次接手指南）

1. **iOS 远端会话文件未提交**（工作区里的 untracked，功能未写完）：
   `Sources/ZephyrUI/RemoteSession.swift`、`RemoteViewModel.swift`、`Views/RemoteView.swift`、
   `Sources/ZephyrCore/MobileApiClient.swift`、`Tests/.../RemoteSessionPhaseTests.swift`、
   `RemoteViewModelTests.swift`。先补完再提交，避免破坏 iOS 编译。
2. **安卓 `PersistentShareStoreTest.twoSharesOverOneDirectoryBothSurvive`**（feature-file-sync，约 123 行）
   仍失败：同一目录下两个 share 的持久化只存活一个，需修 `PersistentShareStore` 实现。
3. **桌面端原生 RDP**：用户硬性要求——直接用 FreeRDP，零 wasm。native FreeRDP 命令已注册
   （`commands/mod.rs` 的 `rdp_native_*`，引擎 `rdp/{mod,session,ffi}.rs`，C 桥 `native/zephyr_rdp.{c,h}`），
   但 `FrameSink` 只有 stub `RecordingSink`，**还没有真实 OS 渲染表面**（帧不得回到 JS/WebView canvas）。
   前端 `zephyr_one/src` 尚未接 RDP 控制面（需走 `@tauri-apps/api` invoke）。
4. **Windows 冒烟自启动**：需把 runtime 自启动从 `.setup()` 挪到 `run()` 里、
   `tauri::Builder::run()` 之前（headless 时 `.setup()` 不执行），用 `current_exe()` 解析路径，
   在 `runtime/mod.rs` 加 `ensure_started_headless()`。
5. **服务端互联其余项**：VNC strict relay、file-bridge 租约、entity adapters
   （对齐 `zephyr_one/mobile/contracts/registries/entity-registry.json`）。

## 四、环境备忘（这台 Windows 机）

- Node 22：`.tooling/node22/node.exe`（跑根/zephyr_one 测试用）。
- Rust 1.97.1 + MSVC 已装；本地桌面构建：`zephyr_one\local-build.bat`（debug，约 5 分钟）。
- 含中文的文件必须经 node_repl（UTF-8）编辑，勿用 PowerShell（会按 GBK 读成乱码）。
- 部分安卓测试文件是 CRLF，node_repl 里匹配要带 `\r\n`。
- 提交用 `git commit -F -`（PowerShell 会吞引号）。
- `.codex/`、`.ci_log_android.txt` 是临时草稿，勿提交。
