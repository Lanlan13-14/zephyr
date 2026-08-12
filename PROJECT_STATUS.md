# 项目现状记录（Project Status Snapshot）

- 记录日期：2026-08-12
- 仓库：Lanlan13-14/zephyr-ssh，分支 main
- 本文件按可验证的事实记录，不夸大进度；未验证的事项明确标注为“未验证”。

## 本次提交内容

1. **嵌入式模式会话加固（server.js）**
   - 嵌入式（Zephyr One 桌面内嵌）模式下禁用浏览器账号密码 / TOTP 登录入口，
     会话只能由启动器一次性 bootstrap 凭证签发。
   - 嵌入式会话通过内存 capability 集合管理，核心重启时吊销全部历史会话。
   - 新增 reissueEmbeddedSessionAfterImport()：导入备份后为已认证的超级管理员
     续发嵌入式会话，旧会话全部吊销。

2. **Windows 运行时启动器（zephyr_one/src-tauri/src/windows_runtime_launcher.rs，新增）**
   - Tauri 启动前的 fail-closed 认证启动器，走 Windows 命名管道 + ACL + Job Object，
     先于 GUI 进程完成运行时鉴权与数据目录处理。
   - runtime/mod.rs：autostart 日志由写文件改为内存缓冲，去掉临时目录回退写盘。

3. **Windows FreeRDP 静态链接闭包（zephyr_one/src-tauri/build.rs）**
   - 将 pkg-config 探测到的完整 FreeRDP 3 链接闭包传递给 zephyr-one bin，
     拒绝 FreeRDP 2 库名与非 MSVC 链接选项，探测结果中途变化会直接 panic 中止构建。

4. **安装冒烟脚本重写（zephyr_one/scripts/windows-install-smoke.ps1）**
   - 针对真实安装目录树的冒烟验证，配合 contract 测试锁定行为。

5. **测试更新**
   - tests/webdav-production-server.test.mjs、tests/zephyr-one-embedded-bootstrap-auth.test.mjs
     等覆盖新的嵌入式会话模型与 WebDAV 隔离场景。

## 已验证

- 2026-08-12 本地运行以下 5 个测试文件，共 24 个用例全部通过（node --test）：
  - tests/password-rollback-contract.test.mjs
  - tests/webdav-production-server.test.mjs
  - tests/zephyr-one-backup-restore.test.mjs
  - tests/zephyr-one-embedded-bootstrap-auth.test.mjs
  - zephyr_one/tests/windows-smoke-contract.test.mjs

## 未验证（如实说明）

- 完整 Node 测试套件（tests/*.test.mjs 全部文件）本次未运行。
- Rust 侧 cargo build / cargo test（zephyr_one/src-tauri）本次未在本地执行。
- Go/WASM 测试（test:go、test:motion-go、test:wasm-build）本次未运行。
- 浏览器冒烟与 iOS 模拟器测试依赖 CI 结果，本地未运行。

## 仓库结构概览

- server.js 与根目录各 *-service.js：Zephyr 核心服务（HTTP/API/会话/WebDAV/AI 等）。
- zephyr_one/：Tauri 桌面端（Windows/macOS/Linux），内嵌 Node 核心子进程。
- zephyr_agent/ 与移动端相关目录：移动客户端与同步运行时。
- rdp-wasm/、motion-wasm/：Go 编译到 WASM 的 RDP 与动画引擎。
- zephyr-ai/、zephyr-worker/：AI 服务与后台 worker。
- tests/、zephyr_one/tests/：Node contract / 集成测试。

## 近期开发主线（依据 git 历史）

- iOS 同步与迁移的健壮性修复（canonical 路径、加密迁移、清理重试）。
- Zephyr One Windows 嵌入式运行时：启动器鉴权、安装冒烟、静态链接闭包。
- CI 修复：vcpkg 基线对齐、FreeRDP patch 输入规范化。
