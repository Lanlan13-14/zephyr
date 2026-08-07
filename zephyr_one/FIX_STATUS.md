# Zephyr One 修复状态（2026-08-07）

本文件记录停止继续修复时的真实状态。当前代码已实现 Windows/Android 安装后直接使用内置核心，应用自身不会在首次启动时把 `zephyr-core` 解压到用户数据目录；但最新 Windows 与 Android 改动尚未全部通过实机/模拟器验证，现有安装包不应作为最终稳定版发布。

## 已完成

- Windows 安装包内置 Node.js 与 Zephyr 核心，不依赖用户安装 Node.js，也不要求用户手动解压。
- Android APK 内置单文件服务端 `assets/zephyr-core.cjs` 和静态资源 `assets/zephyr-public/**`，服务端从 APK 流入 Node 标准输入，静态文件直接从 `base.apk` 读取。
- Android 应用代码不再生成 `zephyr-core.tar`、解压目录或 `.zephyr-one-app-version` 标记。
- 本地 17 项单元测试全部通过，前端生产构建通过。
- 已成功产出过 Windows NSIS/MSI 和 ARM64 Android APK，并验证 APK 包含核心、静态资源及 `libnode.so`，且不包含旧的核心 tar 包。

## 当前未完成/未验证

### Windows

- 上一份已安装构建的窗口可以打开且不会立即闪退，但内置 Node 因 Windows `\\?\C:\...` 扩展路径被误解析为 `C:` 而提前退出。
- 当前代码已加入扩展路径还原和回归测试，但最新 Windows 验证运行在记录本状态时仍在构建，尚未重新安装验证。
- 验证运行：[GitHub Actions 31137655873](https://github.com/Lanlan13-14/zephyr-ssh/actions/runs/31137655873)

### Android

- 上一轮 Android 14 x86_64 模拟器确认应用会因 `ndk-context` 未初始化触发 Rust panic 和 SIGABRT 闪退。
- 当前代码已改为通过 Tauri 已初始化的 WebView/JNI 句柄获取 Activity、APK 路径和 AssetManager，并移除了 `ndk-context` 依赖。
- 最新 Android 运行的基础测试、资源准备和无解压烟雾测试通过，但在“Build signed release APK (aarch64)”步骤失败，因此这次改动尚未完成 Android 编译，也没有进入模拟器复测。
- 失败运行：[GitHub Actions 31137657197](https://github.com/Lanlan13-14/zephyr-ssh/actions/runs/31137657197)，失败任务 `build-android` / job `92740665514`。

## 现有产物说明

`dist-one/` 中现有的 Windows 安装包和 Android APK 均早于上述最后修复：Windows 包仍可能遇到 Node 路径错误，Android 包仍可能遇到 `ndk-context` 闪退。它们只适合诊断，不是最终可交付稳定版。

## 后续接手顺序

1. 查看 Android job `92740665514` 的 Rust 编译错误，修正 Tauri JNI 调用的类型或生命周期问题。
2. 重新跑 Android ARM64、x86_64 构建和 Android 14 模拟器启动测试；确认进程持续存活、健康接口和首页返回 200，且应用数据中没有核心解压文件。
3. 等待或重跑 Windows 验证，下载新 NSIS，覆盖安装后检查内置 Node、健康接口、首页和至少 60 秒持续运行。
4. 两个平台都通过后再生成并标记正式安装包。
