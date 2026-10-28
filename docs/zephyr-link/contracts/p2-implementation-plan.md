# P2 实施合同（本轮只做这个，不是 P3–P6）

规范 §13 P2：实体矩阵、activity append、冲突 UI、Local→Linked 导入。**不允许仅 registry 增加就宣称全量同步。**

基线：`3253c83a286f4a034bff2967dccad0fd06dff461`（P1）。
备份：`/var/minis/workspace/backups/zephyr-link-foundation-v1-before-p2-20261028-001500.bundle`。
工作副本：`/var/minis/workspace/zephyr-link-impl`，分支 `zephyr-link-foundation-v1`。

**禁止：** 宣称 D1–D15 / 互联完成；L5–L8 真机；重编 `.so`；WebDAV 多写；Agent VFS；Handoff/AI RPC 当完成；git commit/push；截断 `server.js` 或任何大文件；改规范正文；把 `serverSettings` / `backupMetadata`（registry `blocked-*`）当成已同步。

P1 已有、不得回退：五类 CAS/outbox/staging/conflict/secret journal、insideTx、180d GC、空 ledger 回填、`sync_projection_failed`。

## 文件所有权（禁止跨组改同一生产文件）

| 组 | 可改 |
|---|---|
| A Desktop 引擎 | `zephyr-one-link-sync.js`、`one-link-local-store.js`、`tests/zephyr-one-link-sync.test.mjs`、`tests/one-link-local-store.test.mjs`。可在 `one_link_meta` additive 加列。**禁止改 UI / server.js / mobile-v1-routes.js** |
| B Activity ingest | `mobile-v1-server-metadata-entities.js`、`storage.js`（仅 activities 去重，禁止改无关表）、`tests/mobile-v1-server-metadata-entities.test.mjs`、可新建 `tests/mobile-v1-activity-ingest.test.mjs`。`server.js` **只允许**在下列已有函数内插入 `addActivity(...)` 调用，禁止改其它逻辑、禁止整文件重写：`destroySshTerminalSession`、SSH/Telnet/RDP/VNC session 创建成功处、`/api/sftp/upload/:token/complete` 成功/失败、SFTP 下载完成、SFTP 删除/重命名已有 handler。改前 `cp server.js /tmp/p2-b-backup/server.js`。 |
| C 冲突/导入 UI | `zephyr-one-link-ui.js`、`public/app.html`（settings-link 段）、`public/i18n/locales/zh-CN.json`、`public/i18n/locales/en.json`、`tests/zephyr-one-link-ui-contract.test.mjs`。禁止改 sync 引擎。 |

## A — Desktop 实体扩面 + D1 导入 + 冲突 HTTP

当前缺口：

1. `MIRROR_TYPES` 只有五类。主端已接线但 Desktop 不镜像：`snippet` `oneUserSettings` `aiProvider` `aiMemory` `aiSkill` `aiEnv` `aiTodo` `aiConversation` `aiMessage` `fileSyncConfig` `workspaceState` `clientToken` `resourceAcl`。`activityEvent` 只读。`serverSettings`/`backupMetadata` **禁止**加入。
2. **SYNC-ID-002 / D1**：绑定后第一次 `syncNow` 在 bootstrap 完成后会 `_captureDirtyRows` 把本机已有行全部当 dirty 上传。必须默认**不自动上传**。
3. 冲突引擎已有 `resolveConflict` / `copyConflictAsNew`，但 `publicState` 不含冲突详情，也没有 HTTP。

必须做：

- `MIRROR_TYPES`：上列可写类型。`READ_ONLY_MIRROR_TYPES = {'activityEvent'}`：bootstrap/pull 可 apply，**`recordLocalMutation` / `_captureDirtyRows` / `_pushPending` 永不入队**。
- 依赖顺序 push：在现有 `PUSH_TYPE_ORDER` 前插入 `clientToken`，`aiProvider` 先于 `aiConversation`/`aiMessage`，`aiEnv` 先于依赖它的类型。未知类型排最后。
- **导入门闩**（D1）：
  - state 增加 `importDecisionRequired`（bool）、`importPreview`（每类型 `{localCount, remoteCount, defaultAction:'keep_local'}`）。
  - `_consumeEnrollment` / 换绑成功后：若本机 `MIRROR_TYPES` 有任何非 ephemeral 行，设 `importDecisionRequired=true`，**在用户 apply 之前 `_pushPending` 直接 return**。bootstrap/pull 仍可跑。
  - `previewImport()`：按 adapter.list 统计本地行（不含 ephemeral connection），返回 `{ types: [{entityType, localCount, sample:[{id,name}]}] }`。
  - `applyImport({ decisions: { [entityType]: 'import'|'keep_local'|'copy_as_new' } })`：
    - `keep_local`：不 enqueue；这些 id 记入 `localOnlyIds`，pull/bootstrap 不得覆盖（视为 pending overlay / 不 apply remote upsert/delete）。
    - `import`：对本地行 `_enqueue` upsert `baseRevision=0`（若远端 bootstrap 已有同 id，必须 `copy_as_new` 而不是静默覆盖远端）。
    - `copy_as_new`：新 UUID 复制本地行再 enqueue；原 id 保持 local-only。
  - 全部类型都有决定后 `importDecisionRequired=false`，此后才允许 `_pushPending`。
  - 无本地行：不设门闩（现有空库绑定测试不得坏）。
- HTTP（`mountZephyrOneLinkRoutes`）：
  - `GET /api/one/link/conflicts` → `{ ok, conflicts: [{conflictId,entityType,entityId,base,local,server,baseRevision,serverRevision,reason,unresolved}] }` 不含 secret 明文。
  - `POST /api/one/link/conflicts/:id/resolve` body `{ resolution: 'keep_local'|'keep_server'|'manual_merge', mergedPayload? }`
  - `POST /api/one/link/conflicts/:id/copy` → `{ ok, copyId }` UUID 且不等于 `*-copy`
  - `GET /api/one/link/import-preview`
  - `POST /api/one/link/import-apply`
- `publicState` 增加 `importDecisionRequired`、`conflicts` 摘要（id/type/reason/unresolved，不要整份 payload）、只读 `readOnlyTypes`。

测试（node:test）：

- 绑定后本机已有 note，未 applyImport 前 `_pushPending` 不发 HTTP push。
- `keep_local`：本地 title 保留，remote upsert 同 id 不覆盖。
- `copy_as_new`：新 UUID 入 outbox，原 id 仍在。
- `import`：空远端时本地 note 以 baseRevision 0 入队。
- 同 id 已在 bootstrap 镜像：`import` 不得覆盖，自动走 copy。
- `activityEvent` 变化不进 outbox。
- `serverSettings` 不在 MIRROR_TYPES。
- snippet 本地编辑会 enqueue（有 adapter 即可，可用 memoryAdapter）。
- 现有 P0/P1 测试全绿。

跑：`node --test tests/zephyr-one-link-sync.test.mjs tests/one-link-local-store.test.mjs`

## B — activityEvent 真 append / 去重 / 会话与 SFTP 埋点

当前：`CanonicalActivityEventService.appendActivityEvent` + `server.js addActivity` 已把部分账户/连接 CRUD 写入 `activities` 并 `recordMutation`。缺口：

1. `storage.addActivity` 遇重复 PK 会抛错，不是幂等 ingest。
2. SSH/Telnet/RDP/VNC **会话开始/失败/断开**、SFTP 上传/下载/删除 没有统一 `addActivity`。
3. 规范：命令原文、密码、私钥、完整 AI prompt **不得**进入活动同步。投影已把 `message` 换成 allow-list 标签；必须加 canary 测试，并保证 `addActivity` 的 message 不含命令原文/密码。
4. 清空：`storage.clearActivities()` 是无日志 DELETE。至少：清空时对每个曾有 activity 的 owner `recordMutation` 一条 `action:'delete'` 或提高 per-owner activity epoch，不能让对端以为历史还在。

必须做：

- `storage.addActivity`：`INSERT OR IGNORE`（或先 SELECT id）。返回 `{ inserted: bool }`。
- `appendActivityEvent`：未插入则 **不** `recordMutation`（幂等）。插入则 `forceChange: true`（append-only，fieldMask 空）。
- 事件字段尽量填：`id`(uuid)、`type`（`session_start|session_end|session_fail|sftp_upload|sftp_download|sftp_delete|sftp_rename|ai_tool|info|error`）、`protocol`、`connectionId`、`outcome`、`durationMs`、`target`（host:port 或远端路径，**不要**命令原文）。
- `destroySshTerminalSession`：一次 `session_end`（reason 映射 outcome；`client-disconnect`/`auth-failed` 可区分）。避免每个 destroy 重复：session.closed 已有，只在真正关闭时记一次。
- SSH session 创建成功（`sshTerminalSessions.set` 附近）记 `session_start`。Telnet/RDP/VNC 若有对等 destroy/create，同样埋；没有对等函数就只做 SSH+SFTP，测试写明。
- SFTP upload complete 成功/校验失败各一条；下载完成、删除、重命名若已有 handler 则埋。message 用短标签如 `SFTP 上传完成`，target 用路径。
- `clearActivities`：删行前读出 distinct userId，删完后对每个 owner `changeBridge.recordMutation({ entityType:'activityEvent', entityId: '__clear__', action:'delete', forceChange:true })` 或 bump epoch。测试：清空后 change feed 有 delete，list 为空。
- 投影 canary：row.message 即使含 `password=secret` / `rm -rf` / 长 prompt，投影 `message` 仍是 allow-list 标签，payload JSON 不含原文字符串。

测试：

- 两次相同 id append → activities 1 行，change feed 1 条。
- session destroy 产生 session_end。
- SFTP complete 产生 sftp_upload。
- 投影剥离 canary。
- clear 后 list 空且有 delete mutation。
- 现有 metadata 测试全绿。

跑：`node --test tests/mobile-v1-server-metadata-entities.test.mjs tests/mobile-v1-activity-ingest.test.mjs`

`server.js` 若被截断：立刻从 `/tmp/p2-b-backup/server.js` 恢复。

## C — 冲突中心与导入预览 UI

当前：`#linkConflictList` 只渲染 “N 个冲突” 一行字，没有 keep/copy 按钮。绑定流程没有导入预览。

必须做：

- 冲突列表：对每个 unresolved conflict 显示 entityType、名称/id、reason；按钮「保留本机」「用主端」「另存副本」。点按钮调 A 的 HTTP。成功后 refresh。
- `manual_merge` 本轮 UI 可不做编辑器，但列表若 `mergedPayload` 含 `<<<<<<<` 要显示“需手动合并”且禁用假装成功的一键合并。
- 绑定成功且 `importDecisionRequired`：在 `#linkBindStatus` 或独立 `#linkImportPanel` 列出每类型本地数量，每类型 radio：导入 / 仅保本地 / 副本。主按钮「应用导入决定」POST import-apply。未应用前「立即同步」不得让用户以为已经上传（可 disable 或文案「先完成导入决定」）。
- i18n 中英都加：保留本机、用主端、另存副本、导入、仅保本地、副本、应用导入决定、需手动合并。
- 现有 UI contract 测试保留并追加：冲突按钮 id、import panel id、i18n keys。

跑：`node --test tests/zephyr-one-link-ui-contract.test.mjs tests/i18n-global-audit.test.mjs`（若 i18n 审计存在且会被新 key 影响）。

## 完成后各组交回

改动文件、测试计数、没做的编号、server.js 是否只在允许点改过。不要 commit/push。
