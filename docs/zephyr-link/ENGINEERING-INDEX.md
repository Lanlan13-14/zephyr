# Zephyr Link 工程索引：改什么，查什么，必须测什么

> 本索引帮助实施者避免“只修自己这一端”的局部正确。它不替代架构规范或测试门禁；真实代码位置随提交变化时，先重新定位真实调用链，不得凭旧行号修改。

## 1. 文档与合同

| 要找的内容 | 入口 |
|---|---|
| D1–D15 产品决策、全互联架构 | `docs/zephyr-link/ZEPHYR-LINK-INTERCONNECTION-SPEC.md` |
| 测试分层、影响声明、故障目录、发布报告 | `docs/zephyr-link/TESTING-AND-RELEASE-GATES.md` |
| Agent 本机策略 JSON 示例 | `docs/zephyr-link/contracts/agent-policy-v1.example.json` |
| Agent 权限交集正反向量 | `docs/zephyr-link/contracts/agent-authorization-v1.cases.json` |
| 新 Link 业务 body 信封 | `docs/zephyr-link/contracts/link-frame-envelope-v1.example.json` |
| Link PR 影响声明 | `docs/zephyr-link/contracts/change-impact-v1.example.json` |
| 已批准决策机器记录 | `docs/zephyr-link/contracts/decision-record-v1.json` |
| 文档/协议一致性验证 | `node docs/zephyr-link/verify-docs.mjs` |

## 2. 现状关键调用链

| 主题 | 当前生产入口 | 修改前必须同时检查 |
|---|---|---|
| Node/Go KIND 与 codec | `link-v2-codec.js`；`zephyr-link/internal/codec/codec.go` | Go/Node 映射、interop vectors、共享 session 的其他 lane |
| ZSL/2 握手/传输 | `link-v2-zsl.js`、`link-v2-transport.js`；`zephyr-link/internal/zsl/`、`internal/link/` | 撤销、session 生命周期、旧 epoch、实际 Go 二进制 |
| 主端同步核心 | `mobile-v1-routes.js`、`mobile-v1-store.js`、`mobile-v1-entities.js`、`mobile-v1-change-bridge.js` | canonical services、field ledger、bootstrap、delete/GC、secret envelopes |
| Android 同步 | `core-sync/`、`core-data/LocalWriteGateway.kt`、`MirrorWriter.kt`、`RoomSyncLocalStore.kt` | Room 事务、SecretMutationJournal、业务 DI、真实 App UI、Go Link transport |
| iOS 同步 | `ZephyrCore/SyncEngine.swift`、`SyncScheduler.swift`、`SQLiteSyncRepository.swift`、`MobileBindingCoordinator.swift` | 真实 App 宿主 repository/ConnectionStore，不能只看核心库与 fake tests |
| Desktop 同步 | `zephyr-one-link-sync.js`、`zephyr-one-link-ui.js` | outbox/CAS/cursor/账号隔离/真实 embedded core；旧 `src/js/sync/` 兼容面 |
| Shared 在线使用 | `mobile-v1-shared.js`、`mobile-v1-routes.js` | 统一禁键出口、一次性票据、ACL/依赖撤销、relay 与 lease 生命周期 |
| Agent/文件/隧道 | `zephyr-link/internal/link/`、`file-agent-manager.js`、`link-v2-file-bridge.js` | **Agent 本机策略**、系统目录权限、VFS/path jail、listener/lease 回收 |
| AI/Cell | `zephyr-ai/`、`zephyr-cell/`、`ai-agent-service.js` | run/approval/epoch、SecretRef、真实工具与执行位置，不能只测 echo ack |
| WebDAV | `webdav-*.js`、`docs/WEBDAV_BACKUP.md`；目标 `zephyr-link/internal/sync/webdav/` | 备份与同步的区别、独立密码、恢复、ETag/CAS、多设备与回滚 |

## 3. 工程师最小工作流

1. 阅读本次改动对应的 D 项、通道、数据域及 Agent 权限规则。
2. 从真实调用入口验证功能当前是否存在，区分“合同/接口存在”和“生产已接线”。
3. 备份数据库和当前分支，记录原版本可复现行为；数据迁移前先准备回滚。
4. 写 `change-impact` 声明及最小阻断测试集。
5. 添加会先失败的回归：旧版失败、修后通过，不能用 mock 取代被测系统。
6. 实现并跑受影响层的测试；检查共享 session、密钥库、canonical store 的相邻通道。
7. 对协议改动同步更新 Node/Go/Kotlin/Swift 合同、错误码和互操作向量。
8. 对 Agent 改动验证本机拒绝与主端不能越权，不只验证主端允许。
9. 对发布改动检查实际安装包、Go toolchain、源码 revision、签名与启动。
10. 附上原始日志、设备/版本、未覆盖项与回滚方案，未覆盖即未通过。

## 4. 常见“看似完成，实际不算完成”

- 只把 `activityEvent` 加进 `pushOrder` → 没有本地 append 与主端 ingest。
- 只给 `Connection` 增加 `initiateViaPrimary` → 没有主端会话锚定与 Handoff 协议。
- 只注册 `KIND.AI` 或返回 ack → 没有 AI dispatch/执行/审批/结果。
- 只显示 Agent 文件树 → 没有 VFS 后端、路径安全、实际流式读写。
- 只在主端显示“允许” → Agent 本机可能拒绝，最终能力仍未成立。
- 只让 Node/Go 单测通过 → 实际客户端 revision/cursor/账号域仍可能错误。
- 只改 workflow 的 Go 版本 → 已提交/已发布 `.so` 仍可能是旧工具链。
- 只完成动画或 Smartbar 图标 → 没有快照、epoch、真实上游和流恢复。
- 只做 WebDAV 加密上传 → 不是多写同步，也不能证明可离线恢复。

[RULES I BROKE]：无。
