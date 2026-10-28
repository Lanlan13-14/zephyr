# P3 实施合同（本轮只做可在本机证明的接线，不是宣称 L5–L8 完成）

规范 §13 P3：iOS/Android 生产接线、ZSL transport、三端两两互测。**mock 不得替代真实 App 与主端联测。**

基线：`4eca54e698ad107e6e50a25808cd9d5e0910f5d2`（P2）。
备份：`/var/minis/workspace/backups/zephyr-link-foundation-v1-before-p3-20261028-220000.bundle`。
工作副本：`/var/minis/workspace/zephyr-link-impl`，分支 `zephyr-link-foundation-v1`。

**禁止宣称：** D1–D15 完成；L5 真机 App；L6 两台真机+主端 E2E；L7 安装包/`go version -m` 重发 `.so`；L8 弱网 soak；WebDAV 多写；Agent VFS；Handoff/AI RPC。本环境无 Android SDK、无 Xcode、Go 为 1.23.9 不是发布工具链 1.26.10。未跑的层必须标 **未验证**。

**禁止：** git commit/push；截断 `server.js` / 大文件；改规范正文；发明第二套 sync 业务核。

P0–P2 已有、不得回退：Desktop CAS/staging/D1 导入/冲突 HTTP；主端 overlap/GC/insideTx；activity ingest；Android `LinkSyncTransport` + `AccountContainer` 已走 ZSL。

## 本轮真实缺口

| 端 | 现状 | P3 要做 |
|---|---|---|
| Android | `AccountContainer` 绑定后 `LinkSyncTransport` 已走 embedded Go `/link/dial`+`/link/push` | D1：首次绑定有本地行默认不 push（对齐 Desktop P2） |
| Desktop | `zephyr-one-link-sync.js` 全部 `_authorizedRequest` 走 HTTPS + device proof。`OneLinkInitiator` 只会跳板，注释写明 sync 仍是明文 HTTPS | 绑定后 bootstrap/changes/push/ack 走同一 embed `/link/push`；capabilities/enrollment/proof 仍 HTTPS |
| iOS | `MobileBindingCoordinator` 只用 `RefreshingSyncTransport` → `MobileApiClient` HTTPS。没有 LinkChannel / Go FFI | 增加与 Android 同形状的 `LinkSyncTransport` + `LinkChannel`；coordinator **可选**注入 channel；无 channel 时保持 HTTPS。本环境不能编 IPA，不得宣称 iOS 已走 ZSL 真机 |
| 三端互测 | 无模拟器/真机 | Node+Go 已有 `syncbridge` 单测继续绿；新增 Desktop 与 Android **同一 op 线形**的契约测试。不得用 mock 两端冒充 L6 |

## 文件所有权

| 组 | 可改 |
|---|---|
| A Desktop ZSL | `zephyr-one-link-embed.js`、`zephyr-one-link-sync.js`、`server.js`（**只**把 `oneLinkInitiator` 的 `LinkEmbedProcess` 注入 sync，或给 `createZephyrOneLinkSync` 传 `linkClient`；禁止其它 server.js 改动）、`tests/zephyr-one-link-sync.test.mjs`、可新建 `tests/zephyr-one-link-zsl-transport.test.mjs` |
| B iOS Link transport | 仅 `zephyr_one/mobile/ios/Sources/ZephyrCore/` 与 `zephyr_one/mobile/ios/Tests/ZephyrCoreTests/`。新建 `LinkSyncTransport.swift`；改 `MobileBindingCoordinator.swift` 只增加可选 `linkChannel` 工厂，默认仍 HTTPS。可新建 `LinkSyncTransportTests.swift`。禁止改 Android/Node |
| C Android D1 | `zephyr_one/mobile/android/core-sync/`、`core-data/` 中 sync state / SyncActor / 测试。禁止改 Desktop/iOS。Room 迁移必须 additive |

## A — Desktop owned-sync 走 ZSL

现状：`zephyr-one-link-embed.js` 注释写明 desktop sync 是 HTTPS。Android `EmbeddedLinkApi.push` 已 POST embed `/link/push`。Go `node.go` 已有 `/link/dial`、`/link/dial/finish`、`/link/push`。

必须做：

1. 在 `zephyr-one-link-embed.js` 新增 `OneLinkSyncSession`（不要复用 `OneLinkInitiator._dial` 里的 `/link/tunnel/initiator/start`，那是跳板）：
   - `getIdentity` 与 initiator 相同：`serverUrl, deviceId, privateKeyPem, allowInsecureTls`
   - `ensureSession()`：`POST /link/dial`，若 `pending` 则用现有 `handshakeProof` 再 `/link/dial/finish`。**不要**调 initiator/start。
   - `push({ kind, body })`：`POST /link/push` `{ sessionId, peerUrl, kind, body, secret:false }`，peerUrl = `serverUrl.replace(/\/+$/,'') + '/api/link/v2'`（与 Android `linkRoot` 一致）。
   - 返回 `{ ackKind, ack }`。ack.ok===false 时抛错，带 `code/retryable`（对齐 Android `LinkChannelException`）。
   - sessionInvalid / 通道失败时清 sessionId 允许重拨一次。
   - 可注入 `process`（`LinkEmbedProcess`），与 initiator 共享子进程。

2. `ZephyrOneLinkSync` 构造增加 `linkClient`（有 `ensureSession`+`push` 即可）。`server.js` 在 `createZephyrOneLinkSync` 传入基于同一 identity 的 `OneLinkSyncSession`。无 embed bin 时 `linkClient` 可为 null，HTTPS 路径必须继续通过现有测试。

3. `_authorizedRequest`：当 `linkClient` 存在且 path 是
   `/api/mobile/v1/sync/bootstrap|changes|push|ack`
   时 **不发 HTTPS、不发 proof-challenge**。改为：
   ```
   op = bootstrap|changes|push|ack
   body = { op, ...queryOrBody without undefined }
   ack = await linkClient.push({ kind: 1 /* SYNC_OP */, body })
   ```
   成功返回 ack（去掉外层 op）。失败映射现有 `httpError` 形状（status/code/retryable）。
   capabilities、enrollment、unbind、proof-challenge **仍 HTTPS**。

4. 测试（fake linkClient，不要真 spawn Go）：
   - bootstrap/changes/push/ack 各一次：`push` 被调用，kind===1，body.op 正确；HTTP 不被调用这些 path。
   - capabilities 仍走 HTTP。
   - 无 linkClient 时现有 HTTPS 测试全绿。
   - ack.ok===false 且 code=cursor_expired 时 throw 带该 code。
   - 现有 P0–P2 测试全绿。

跑：`node --check zephyr-one-link-embed.js zephyr-one-link-sync.js`  
`node --test tests/zephyr-one-link-sync.test.mjs tests/zephyr-one-link-zsl-transport.test.mjs`

## B — iOS LinkSyncTransport（与 Android 同线形）

Android 参考：`core-sync/.../LinkSyncTransport.kt` + `LinkSyncTransportTest.kt`。

必须做：

1. 新建 `zephyr_one/mobile/ios/Sources/ZephyrCore/LinkSyncTransport.swift`：
   - `protocol LinkChannel`：`var isEstablished: Bool`；`func syncOp(op: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue]`（若项目已有 JSON 类型就用现有，不要再发明一套；必要时用 `MobileJSONValue` 或与 `MobileApiClient` 相同的编码）。
   - `LinkChannelError`：code/retryable/details。
   - `LinkSyncTransport: SyncTransport`：capabilities 走 `httpFallback`；bootstrap/changes/push/ack 走 channel，body 必须含 `"op"` 且其余字段与 HTTPS DTO 相同（protocolVersion/deviceId/batchId/...）。
   - **不要**在 syncOp 前用 `isEstablished` 拒绝（Android 注释：懒拨号）。
   - 失败 ack `{ok:false,error:{code,message,retryable,details}}` 映射为 `MobileApiError`，保留 code。

2. `MobileBindingCoordinator`：给 `makeRuntime` 增加可选 `linkChannel: (LinkChannel)?` 或工厂。有 channel 时 `transport = LinkSyncTransport(channel:deviceId:fallback:)`；无则保持 `RefreshingSyncTransport`。默认路径不得变。

3. 测试 `LinkSyncTransportTests.swift` 对齐 Android：
   - bootstrap 不调 HTTP fallback
   - changes 编码 sinceCursor
   - push 含 PushRequest 字段且 op=push
   - cursor_expired 保留 code
   本环境可能没有 `swift`/`xcodebuild`。必须保证文件可编译语义正确；在报告写明 **未跑 Xcode**。若 `which swift` 可用就 `swift test`。

禁止在 iOS 树加假 Go `.a` 冒充 FFI。

## C — Android D1 首次绑定不自动上传

对齐 Desktop P2 `importDecisionRequired`。

必须做（最小）：

1. `SyncStateRow` additive 列 `importDecisionRequired: Boolean = false`（Room `@ColumnInfo` default）。Migration 只 ADD COLUMN。
2. `SyncActor` 在 `PUSH_PENDING`：若 store 该 binding `importDecisionRequired==true`，**跳过 push**（不调用 transport.push），仍允许 bootstrap/pull/ack。
3. 绑定完成：若本地 writable 实体有行，置 `importDecisionRequired=true`。空库 false。
4. 公开 `applyImportDecisions` 或 repository 方法：全部类型处理后清 flag。本轮 UI 可以没有导入面板，但 **flag 默认挡住 push** 必须有。keep_local 语义：清 flag 且不 enqueue 已有行（或把已有 pending 标 cancelled）。不要在没 UI 时偷偷 import。
5. 测试：`SyncActorTest` 有本地 pending + flag true → push 0 次；flag false → push 发生。

跑不了 Gradle 就写测试并 `node` 静态断言源码含 `importDecisionRequired` 与 PUSH 跳过。报告写明 **未跑 instrumentation**。

## 明确未做

- 真机/模拟器 Android↔iOS↔Desktop 互测（L6）
- 重编 `libzephyr_link.so` / iOS `.a`
- RDP/VNC 会话 activity（P2 已声明）
- iOS 真 Go embed 进程

## 完成后交回

diff --stat、测试计数、Desktop 是否默认注入 linkClient、iOS 默认是否仍 HTTPS、Android flag 默认是否挡住 push、未验证层清单。不要 commit。
