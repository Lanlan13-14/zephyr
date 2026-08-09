# Zephyr One 原生实现状态

> [KNOWN] 合同基线：`main@8dd5b98`，2026-08-08。实现基线：`main@1a9f843` + 本次工作树改动，2026-08-09。
>
> [KNOWN] `zephyr_one/mobile/` 已落地，本表下列各行按 `b0e5a9c` 实测重新判定。逐项规模、缺口与里程碑差距见 [`DEVELOPMENT.md`](DEVELOPMENT.md) 2.4；两处冲突时以该节为准。
>
> [KNOWN] 本文件只报告仓库实际存在的代码与合同，不把设计文档当实现。

## 状态枚举

- `implemented-zephyr`：Zephyr Web/server 已有并有代码。
- `legacy-one`：旧 Tauri One 已有，不能当 Kotlin/Swift 原生完成。
- `specified`：本目录已写可执行合同，但生产代码未实现。
- `partial`：有部分 server/legacy 实现，缺完整合同目标。
- `blocked`：前置模型/依赖未冻结或现有实现必须迁移。
- `missing`：没有实现也没有足够合同。

## 总览

| 层 | 状态 | 证据/缺口 |
| --- | --- | --- |
| 产品合同 | `specified` | [KNOWN] `PRODUCT_REQUIREMENTS.md` |
| Zephyr 继承规则 | `specified` | [KNOWN] `ZEPHYR_PARITY.md` |
| machine contracts | `specified` | [KNOWN] 20 实体／66 错误码／15 份 codegen 产物；`zephyr_one/mobile/tests` 74 项全过，`check:drift` 无漂移 |
| Android Kotlin/Compose | `partial` | [KNOWN] `zephyr_one/mobile/android` 21 模块、295 个 `.kt`／53,719 行、150 个 `@Composable`、7/23 屏幕；`ZephyrOneRoot` / `AccountContainer` / `ZephyrApplication` / `SecretStore.SecretScope` 四处未声明引用已补齐并由 `mobile/tests/kotlin-symbols.test.mjs` 看守；仍无 Gradle wrapper、无 CI、**从未编译** |
| iOS Swift/SwiftUI | `missing` | [KNOWN] `zephyr_one/mobile/ios` 仅有 6 个生成合同 Swift 文件／717 行；无 `Package.swift`、无 Xcode 工程、无 App 代码 |
| mobile v1 server API | `partial` | [KNOWN] `mobile-v1-routes.js` / `mobile-v1-store.js` / `mobile-v1-entities.js` / `mobile-v1-shared.js` / `mobile-v1-crypto.js`，由 `server.js` 挂载；20 个 mobile v1 操作全部有实现（capabilities / bind / refresh / devices CRUD / bootstrap / changes / push / ack / now / status / sensitive.verify / shared 目录与详情 / invoke / session open+refresh+close / file-bridge lease）；`relay-strict` 会话和 file-bridge 传输通道尚未挂载，因此返回已注册的 `shared_relay_unavailable` / `server_unavailable`，而不是下发一个访问不到的 URL；`mobile/tests` 162 项全过，含 22 项 sync 往返与 27 项 shared residency 回归 |
| Tauri One | `legacy-one` | [KNOWN] `zephyr_one/` 存在，pull-only/localStorage/内嵌 core |
| Zephyr business services | `implemented-zephyr` | [KNOWN] resource/notes/authz/settings/workspace/AI 等 service |
| 完整双向同步 | `partial` | [KNOWN] 服务端 bootstrap/changes/push/ack 已实现（`mobile-v1-routes.js`），并有 22 项 e2e 回归；旧 `/api/one/sync/pull` 仍保留作为 legacy One 路径；客户端 Kotlin 同步引擎**从未编译** |
| 原生协议 engines | `blocked` | [KNOWN] Kotlin/iOS SSH/RDP/VNC 依赖 ADR 未完成 |

## 功能状态

| ID | 功能 | Zephyr 现状 | 原生 One 现状 | 阻断 |
| --- | --- | --- | --- | --- |
| F-001 | 账号登录/TOTP | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生状态机未实现；现有 API 已支持返回 SID |
| F-002 | Client Token 前置绑定 | `partial` | `legacy-one` | [KNOWN] 当前 OneClientManager 可绑定；缺 device keys/refresh/proof |
| F-003 | Device registry | `partial` | `legacy-one` | [KNOWN] `one_clients` 表存在；缺 mobile v1 字段和 tombstone |
| F-004 | 完整双向同步 | `partial` | `partial` | [KNOWN] 服务端 push/changes/ack/bootstrap 已实现并有 e2e 回归：重放同 opId 返回 duplicate、字段重叠返回 conflict、tombstone 不带 payload、游标 GC 后返回 cursor_expired；尚未接入的是 blob 传输与 15 个无 adapter 的 registry 类型 |
| F-005 | Secret envelope | `implemented-zephyr` | `partial` | [KNOWN] device envelope 已双向打通：`/capabilities` 发布 `serverId` 与 ML-KEM-768 公钥，push 按 AAD （serverId/userId/deviceId/entityType/entityId/fieldName/entityRevision/keyVersion）验证并解开密钥，写入规范 service；已测：篋改密文、换绑其他设备、非密钥字段均被拒；change feed 永不带密钥。服务端→设备方向的 envelope 尚未实现 |
| F-006 | Connection CRUD | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生 UI/本地镜像未实现 |
| F-007 | ACL/share | `implemented-zephyr` | `missing` | [KNOWN] 修复：`note` 在 `SHAREABLE_TYPES` 中但 `ResourceService._rawResource` 没有 note 分支，导致按用户共享笔记的两个 API 永远 404；现已按 ACL 形状返回 id/ownerUserId/name 而不带 content。原生 capability UI 未实现 |
| F-008 | SSH/SFTP | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生 SSH engine 未定 |
| F-009 | Telnet | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生 parser/transport 未实现 |
| F-010 | RDP | `implemented-zephyr` | `legacy-one` | [KNOWN] 桌面 One 与浏览器版一样使用 WASM RDP；原生 FreeRDP 引擎**未实现**。树内只有 C core `zephyr_one/native/freerdp-core/`（`zephyr_rdp.{h,c}` + 69 项 C 单测 + 固定 FreeRDP 3.30.0 静态构建脚本），没有 Rust 绑定、没有进程内引擎、没有平台 surface、没有 e2e |
| F-011 | VNC | `implemented-zephyr` | `legacy-one` | [KNOWN] 当前 noVNC；原生 RFB core 未定 |
| F-012 | 终端 IME | `implemented-zephyr` | `specified` | [KNOWN] Web 行为合同已有；原生 SurfaceController 未实现 |
| F-013 | 笔记 | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生列表/编辑/冲突未实现 |
| F-014 | Snippet | `implemented-zephyr` | `legacy-one` | [KNOWN] 当前塞在 user_settings 数组，需实体正规化 |
| F-015 | AI | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生 AI UI 未实现；conversation schema 未冻结 |
| F-016 | Docker/监控/日志 | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生 remote panels 未实现 |
| F-017 | 批量执行 | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生逐机结果 UI 未实现 |
| F-018 | Proxy/SSH Key/JumpHost | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生管理页未实现 |
| F-019 | 工作区恢复 | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生移动 state adapter 未实现 |
| F-020 | Deep Link | `implemented-zephyr` | `legacy-one` | [KNOWN] App/Universal Link wiring 未实现 |
| F-021 | 活动 | `implemented-zephyr` | `legacy-one` | [KNOWN] append-only change hook/原生页未实现 |
| F-022 | 服务器设置 | `implemented-zephyr` | `legacy-one` | [KNOWN] 原生有用途 section 未实现 |
| F-023 | 备份恢复 | `implemented-zephyr` | `legacy-one` | [KNOWN] Web/旧 One E2E 已有；原生 document flow 未实现 |
| F-024 | Client Token 完整互备 | `partial` | `missing` | [KNOWN] 当前 JSON 明文且 sync 只给 metadata |
| F-025 | ZFT2 文件桥接 | `implemented-zephyr` | `legacy-one` | [KNOWN] JS/Dart 已有；Kotlin/Swift 未实现 |
| F-026 | Android SAF foreground bridge | `missing` | `missing` | [KNOWN] 原生项目不存在 |
| F-027 | iOS security-scoped bridge | `missing` | `missing` | [KNOWN] 原生项目不存在 |
| F-028 | 系统 App Lock | `partial` | `legacy-one` | [KNOWN] Tauri hook 非正式 BiometricPrompt/LA 实现 |
| F-029 | 四色原生图标 | `specified` | `partial` | [KNOWN] SVG/manifest 有；production path/adaptive/alternate assets 未生成 |
| F-030 | Tauri → native migration | `specified` | `missing` | [KNOWN] migration artifact/exporter/importer 未实现 |
| F-031 | Android progress-driven 自定义返回 | `specified` | `partial` | [KNOWN] 根导航 `ZephyrOneRoot` 已落地（四入口浮岛 + 沉浸式 surface 切换），但系统 progress 驱动的预测式返回手势与动画仍未实现 |
| F-032 | iOS 全 push interactive 右滑 | `specified` | `missing` | [KNOWN] SwiftUI/UIKit navigation 代码不存在 |
| F-033 | Termux/SwiftTerm 级终端交互 | `specified` | `missing` | [KNOWN] 两端 M0 引擎和 UI 尚未实现 |
| F-034 | RDP/VNC 完整移动交互 | `specified` | `blocked` | [KNOWN] 桌面已有 FreeRDP C shim 可复用为 core 参考，但移动 Surface/UIView 绑定、direct/trackpad 手势与真机验证仍未做；VNC RFB core 仍未选定 |
| F-035 | Zephyr AI 全能力浮窗 | `specified` | `missing` | [KNOWN] 116-tool baseline 已有；原生浮窗和 NativeSurfaceBridge 不存在 |
| F-036 | Shared-to-me 零驻留在线 API | `implemented-zephyr` | `missing` | [KNOWN] `GET /shared`、`GET /shared/{type}/{id}` 已实现：只从 live ACL 投影，`Cache-Control: no-store`，不存任何本地副本；已测：共享行不进 bootstrap/change feed、自有行不走共享面、撤销后下一请求即 404、不存在与无权均 404。原生客户端 UI 未写 |
| F-037 | Shared direct use envelope | `implemented-zephyr` | `missing` | [KNOWN] direct-ephemeral envelope 已实现：ML-KEM-768 封装到设备公钥，AAD 绑定 shared-use-v1/serverId/userId/deviceId/sessionId/resourceId/revision/purpose/expiresAt/clientNonce，payload 为 allow-list（endpoint/username/password/privateKey/domain/mode/encoding）；已测：设备本地能重建 AAD 并解开拿到真实凭据、重放同一 nonce 返回 `shared_session_consumed`、换 nonce 可重新封发、direct 需 owner 放开 control/execute 而不仅 use、session 绑定开它的设备。原生 SessionSecretArena 未写 |
| F-038 | Shared strict relay | `partial` | `missing` | [KNOWN] 会话授权、ACL 复查与审计已实现，但 relay WebSocket 代执行通道本身尚未挂载；按 SHARED_RESOURCE_RESIDENCY.md 3.3 “relay 不可用时明确报错，不能静默下发 secret”，`relay-strict` 直接返回 503 `shared_relay_unavailable` 并销毁会话，已测其不会降级为 direct |
| F-039 | Shared AI 主端执行零泄漏 | `specified` | `partial` | [KNOWN] AI runtime 在主端；One residency/stream client 未实现 |
| F-040 | Shared Note 在线内存 viewer | `implemented-zephyr` | `missing` | [KNOWN] `POST /shared/note/{id}/invoke` 已实现 read/update：每次走主端 NotesService，update 强制 expectedRevision，正文只在 invoke 响应里回一次且 no-store，不进镜像；已测：无 edit 能力的共享者写入被拒、未知 operation 返回 `unsupported_scope`。原生 no-store viewer UI 未写 |

## 当前可复用测试资产

- [KNOWN] 241 个 Node `*.test.mjs` 文件覆盖 Zephyr 多个业务面。
- [KNOWN] `authz.test.mjs`：owner/admin/ACL/expiry/revoke/防枚举。
- [KNOWN] `auth-hardening.test.mjs`：锁定、reset token、TOTP exhaustion。
- [KNOWN] `notes-deeplink.test.mjs`：Note revision/soft-delete、Deep Link、Workspace ACL。
- [KNOWN] `one-client-manager.test.mjs`：Token 前置、撤销、interval clamp。
- [KNOWN] `zephyr-one-backup-restore.test.mjs`：真实导出、错误密码、正确导入。
- [KNOWN] `zephyr_one/tests/zft2-protocol.test.mjs`：ZFT2 round-trip/flags/bad magic/length mismatch。
- [KNOWN] Telnet/SSH/RDP/mobile IME 有现成回归测试，可改造成跨端 fixture。

## 开工顺序

1. [INFERRED] 先实现 server `mobile_0001…0005` 与 machine contract validator。
2. [INFERRED] 迁移 Client Token 明文 JSON，补全 change hooks/tombstones。
3. [INFERRED] 建 Android/iOS 原生项目和共享 fixture runner。
4. [INFERRED] M0 冻结 SSH/RDP/VNC/terminal engine ADR 并跑真机 spike。
5. [INFERRED] 本地 DB/SecretStore/绑定/bootstrap。
6. [INFERRED] Connection/Note/Settings/Token 首批完整 sync，再扩展 registry 每个实体。
7. [INFERRED] 会话协议和文件桥接。
8. [INFERRED] 其余页面、迁移、商店发布门。

## 禁止状态漂移

- [KNOWN] 新提交改变本表任一状态时，必须附代码路径和测试路径；不能只改为“完成”。
- [KNOWN] `implemented-zephyr` 不等于 `implemented-one`。
- [KNOWN] `specified` 不等于生产可用。
- [KNOWN] 任一 `blocked/missing` 的产品必需功能存在时，不得发布“Zephyr One 完整实现”。
