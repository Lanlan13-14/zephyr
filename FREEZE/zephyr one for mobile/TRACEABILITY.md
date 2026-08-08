# Zephyr One 需求 → Zephyr 事实源 → One 实现 → 测试追踪矩阵

> [KNOWN] 这是发布门，不是愿望清单。`One code` 或 `One tests` 为空时，该项不是原生完成。

| ID | 产品需求 | Zephyr 事实源 | 合同/页面 | One code | One tests | 当前状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-001 | Kotlin/Compose + Swift/SwiftUI 原生 | `PRODUCT_REQUIREMENTS §2` | `DEVELOPMENT §4-6` | — | — | `missing` |
| R-002 | 不用整页 WebView | 旧 `public/*` 仅迁移参考 | `ZEPHYR_PARITY §1.2` | — | — | `missing` |
| R-003 | 四入口浮岛 | references image | `SCREEN_CATALOG §1` | — | — | `specified` |
| R-004 | 系统本地解锁 | Tauri `auth` 仅迁移参考 | `SCREEN_CATALOG S01` | — | — | `missing` |
| R-005 | Zephyr 账号登录 | `server.js /api/auth/login` | OpenAPI `LoginRequest` | — | `auth-hardening.test.mjs` 仅 server | `partial` |
| R-006 | TOTP 登录 | `server.js /api/auth/totp/verify` | `ZEPHYR_PARITY §3` | — | `auth-hardening.test.mjs` 仅 server | `partial` |
| R-007 | 遵守 CAPTCHA/IP/锁定 | `checkLoginGuards/verifyCaptcha` | `SCREEN_CATALOG S02` | — | `auth-hardening.test.mjs` 部分 | `partial` |
| R-008 | 主端已有 Token 才绑定 | `one-client-manager.js bind` | OpenAPI `/devices/bind` | legacy only | `one-client-manager.test.mjs` | `partial` |
| R-009 | userId 隔离 | `storage.js/authz.js` | entity registry | — | `user-isolation.test.mjs` | `partial` |
| R-010 | device access/refresh/proof | 无 | OpenAPI security schemes | — | — | `specified` |
| R-011 | 完整 bootstrap | legacy snapshot | `SYNC_STATE_MACHINE §3` | — | — | `specified` |
| R-012 | 双向 push | 无 | OpenAPI `/sync/push` | — | — | `specified` |
| R-013 | change cursor | 无 | `SYNC_STATE_MACHINE §8` | — | — | `specified` |
| R-014 | opId 幂等 | 无 | `SYNC_STATE_MACHINE §6` | — | sync vector only | `specified` |
| R-015 | field conflict | notes/snippet revision | `SYNC_STATE_MACHINE §7-9` | — | sync vector only | `specified` |
| R-016 | tombstone/delete传播 | `notes-service` 部分 | `SYNC_STATE_MACHINE §10` | — | Note server tests only | `partial` |
| R-017 | secret envelope | `secret-crypto.js` at-rest | `DATA_AND_MIGRATION §5` | — | AAD vector only | `specified` |
| R-018 | 自动间隔 + 立即同步 | `one-client-manager clampInterval` | `SCREEN_CATALOG S45` | legacy partial | `one-client-manager.test.mjs` 部分 | `partial` |
| R-019 | 冲突中心 | 无 | `SCREEN_CATALOG S45` | — | — | `specified` |
| R-020 | Connection 完整 CRUD | `resource-service/server/storage` | `ZEPHYR_PARITY §5` | — | Zephyr server tests | `partial` |
| R-021 | ACL/分享 | `authz.js/sharing-service.js` | `ZEPHYR_PARITY §4` | — | `authz.test.mjs` | `partial` |
| R-022 | SSH | `server.js ssh2` + tests | `ZEPHYR_PARITY §6.1` | — | native tests — | `missing` |
| R-023 | Telnet | `telnet-transport.js` + tests | `ZEPHYR_PARITY §6.2` | — | native tests — | `missing` |
| R-024 | RDP | `zephyr_one/native/freerdp-core` C core（无 Rust 绑定/无引擎）；运行路径仍为 WASM | `ZEPHYR_PARITY §6.3` | — | 69 项 C 单测；无引擎测试、无 e2e、无移动测试 | `missing` |
| R-025 | VNC | noVNC/WebSocket | `ZEPHYR_PARITY §6.4` | — | native tests — | `blocked` |
| R-026 | 终端 IME/快捷键/dock | WTerm mobile contract | `SCREEN_CATALOG S21` | — | native UI tests — | `specified` |
| R-027 | SFTP 文件/预览/编辑 | server SFTP APIs | `SCREEN_CATALOG S31` | — | native tests — | `missing` |
| R-028 | 笔记完整能力 | `notes-service.js` | `SCREEN_CATALOG S32` | — | server tests only | `partial` |
| R-029 | Snippet | `ai-snippet-tools.js` | `SCREEN_CATALOG S33` | — | server tests only | `blocked-normalization` |
| R-030 | 工作区恢复 | `workspace-service.js` | `ZEPHYR_PARITY §7.3` | — | server tests only | `partial` |
| R-031 | Deep Link | `deeplink-service.js` | `ZEPHYR_PARITY §7.4` | — | server tests only | `partial` |
| R-032 | 批量执行 | `/api/remote-execute` | `SCREEN_CATALOG S41` | — | server tests only | `partial` |
| R-033 | Docker/监控/日志 | AI/SSH tools | `SCREEN_CATALOG S42` | — | server tests only | `partial` |
| R-034 | Proxy/Key/Jump | `resource-service.js` | `SCREEN_CATALOG S43` | — | server tests only | `partial` |
| R-035 | Zephyr AI 全能力浮窗 | AI runtime + live 116-tool catalog | `AI_FLOATING_WORKSPACE` / `SCREEN_CATALOG S44` / AI baseline | — | catalog parity contract only | `specified-ui-and-bridge-missing` |
| R-036 | Activity | `storage.queryActivities` | entity registry | — | server tests only | `partial` |
| R-037 | 服务器设置 | settings APIs | `SCREEN_CATALOG S48` | — | — | `specified` |
| R-038 | 备份导出 | `/api/data/export` | `SCREEN_CATALOG S49` | legacy Web | `zephyr-one-backup-restore` server/Web | `partial` |
| R-039 | 备份导入回滚 | `/api/data/import` | `DATA_AND_MIGRATION §8` | legacy Web | server/Web E2E | `partial` |
| R-040 | Client Token CRUD | `file-agent-manager.js` | `SCREEN_CATALOG S46` | legacy Web | token/server tests | `partial` |
| R-041 | Token secret 互备 | 当前 metadata only | entity registry | — | — | `blocked-migration` |
| R-042 | 敏感操作密码/TOTP | `verifySensitiveAccess` | OpenAPI sensitive verify | legacy direct secret | — | `partial` |
| R-043 | ZFT2 v2 | `file-transfer-protocol.js` | `ZEPHYR_PARITY §10.2` | — | Node/Dart only | `partial` |
| R-044 | Android SAF bridge | Flutter Agent 参考 | `SCREEN_CATALOG S47` | — | — | `missing` |
| R-045 | iOS scoped bridge | 无正式实现 | `SCREEN_CATALOG S47` | — | — | `missing` |
| R-046 | RDP 只读目录 | 产品字段/Agent capability | `ZEPHYR_PARITY §6.3` | — | — | `specified` |
| R-047 | 四色 App icon | branding sources/manifest | `DEVELOPMENT §6.6` | partial assets | — | `partial` |
| R-048 | Tauri → native migration | legacy `zephyr_one` | `DATA_AND_MIGRATION §7` | — | — | `specified` |
| R-049 | structured error registry | mixed server errors | `contracts/error-registry.json` | — | schema only | `specified` |
| R-050 | 需求覆盖发布门 | 本文件 | `IMPLEMENTATION_STATUS.md` | — | CI validator pending | `specified` |
| R-051 | Android 自定义 progress 返回视觉 | Android system back APIs | `MOBILE_EXPERIENCE §2.3/§9.1` | — | spec contract only | `specified-ui-missing` |
| R-052 | iOS 全 push interactive 右滑 | iOS navigation semantics | `MOBILE_EXPERIENCE §2.2/§9.1` | — | spec contract only | `specified-ui-missing` |
| R-053 | Termux 级 SSH/Telnet 手感 | Termux behavior + Zephyr WTerm | `TERMINAL_EXPERIENCE` | — | spec contract only | `specified-engine-ui-missing` |
| R-054 | RDP/VNC 完整移动交互 | FreeRDP/VNC core + Zephyr fields | `REMOTE_DESKTOP_EXPERIENCE` | — | spec contract only | `specified-engine-ui-missing` |
| R-055 | AI 原生 semantic/action bridge | Zephyr `ui_action`/tool catalog | `AI_FLOATING_WORKSPACE §4` | — | catalog parity contract only | `specified-bridge-missing` |
| R-056 | Shared-to-me 零驻留 | Zephyr ACL/ResourceService | `SHARED_RESOURCE_RESIDENCY §2/§6` | — | spec contract only | `specified-api-client-missing` |
| R-057 | Shared connection direct use envelope | ResourceService dependency ACL | `SHARED_RESOURCE_RESIDENCY §3.2` | — | vectors/implementation missing | `specified-crypto-missing` |
| R-058 | Shared connection strict relay | Zephyr SSH/RDP/VNC proxies | `SHARED_RESOURCE_RESIDENCY §3.3` | — | relay protocol missing | `specified-server-client-missing` |
| R-059 | Shared AI 主端执行 | Zephyr AI runtime/tools | `SHARED_RESOURCE_RESIDENCY §4` | — | residency E2E missing | `specified-client-missing` |
| R-060 | Shared Note 在线暂存 | NotesService/Authz | `SHARED_RESOURCE_RESIDENCY §5` | — | residency E2E missing | `specified-client-missing` |

## 发布判定算法

[KNOWN] 以下任一成立则失败：

1. 必需行状态不是 `implemented`。
2. `One code` 或 `One tests` 为空。
3. Android/iOS 只有一端实现。
4. server test 通过但没有 native 解码/UI/真机测试。
5. entity registry 有 `blocked` 或未分类字段。
6. OpenAPI 与真实路由漂移。
7. 产品排除项在 screen catalog 或原生导航重新出现。

[INFERRED] CI 应解析本表或后续等价 YAML；每个 R-ID 绑定 Android test、iOS test、server test、artifact evidence。Markdown 是人读视图，机器真源后续可生成 `traceability.json`，但两者不能手工双写。
