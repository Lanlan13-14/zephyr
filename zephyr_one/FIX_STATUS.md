# Zephyr One 修复状态（2026-08-07）

本文件记录当前真实状态。Windows 扩展路径与 Android 无解压核心已落地；Android 编译失败的根因已按 Tauri 2 **稳定 API** 修掉，待 CI 重新验证。

## 已完成

- Windows 安装包内置 Node.js 与 Zephyr 核心，不依赖用户安装 Node.js，也不要求用户手动解压。
- Windows `\\?\C:\...` 扩展路径在传给 Node 前还原为普通路径（`node_compatible_path` + 回归测试）。
- Android APK 内置单文件服务端 `assets/zephyr-core.cjs` 和静态资源 `assets/zephyr-public/**`，服务端从 APK 流入 Node 标准输入，静态文件直接从 `base.apk` 读取。
- Android 应用代码不再生成 `zephyr-core.tar`、解压目录或 `.zephyr-one-app-version` 标记。
- Android JNI 底座（相对失败 run `31137657197`）：
  - **不再调用** `Manager::webviews()`（Tauri 2 仅在 `feature = "unstable"` 下公开，稳定面编译失败 E0599）。
  - 改用稳定 API：`get_webview_window("main")` / `webview_windows()` → `WebviewWindow::with_webview` → `PlatformWebview::jni_handle().exec`。
  - AAsset **不得跨线程持有**：在 WebView/JNI 线程内 open → 读完整 `Vec<u8>` → close，再以 `Cursor` 写入 Node stdin。
  - 核心 asset 与 APK 路径在 **spawn Node 之前** 解析，避免半启动僵尸进程。
  - `libnode.so` 优先 `ApplicationInfo.nativeLibraryDir`，去掉对 `filesDir/lib/<abi>` 的臆测路径。
  - `resolve_core_dir` 仅桌面；Android 不走文件系统核心。
  - 清理未使用依赖 `base64` 与 lockfile 残留 `tar`。
- 本地 17 项单元测试全部通过（含稳定 API / no-extract 契约）。

## 当前未完成/未验证

### Android

- 上轮失败：job `92740665514`，`error[E0599]: no method named webviews`（已在本轮源码消除）。
- 需重新跑 ARM64 + x86_64 构建，以及 Android 14 模拟器启动烟雾：进程存活、`/healthz` 与首页 200、应用数据中无核心解压目录。

### Windows

- 扩展路径修复已合入；验证 run [31137655873](https://github.com/Lanlan13-14/zephyr-ssh/actions/runs/31137655873) 结论 success，仍建议覆盖安装后确认内置 Node 持续运行 ≥60s。

## 现有产物说明

`dist-one/` 中若仍有旧包：Android 可能含 `ndk-context` 闪退或旧 tar 方案；Windows 可能含路径问题。只适合诊断，不是最终可交付稳定版。

## 后续接手顺序

1. CI 验证 Android `Build signed release APK (aarch64)` 与 x86_64 + 模拟器烟雾通过。
2. 确认 Windows 安装包健康接口与持续运行。
3. 两平台通过后再打正式 release 产物。
