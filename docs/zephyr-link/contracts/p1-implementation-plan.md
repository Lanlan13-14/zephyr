# P1 实施合同（本轮只做这个，不是 P2–P6）

规范入口：`docs/zephyr-link/ZEPHYR-LINK-INTERCONNECTION-SPEC.md` §5、§13 P1；测试：`TESTING-AND-RELEASE-GATES.md` §4.1–4.4、§11。

基线 commit：`2b65f00952022bd3039965bfe940d66d6be44410`。
备份：`/var/minis/workspace/backups/zephyr-link-foundation-v1-before-p1-20261027-230500.bundle`。
工作副本：`/var/minis/workspace/zephyr-link-impl`，分支 `zephyr-link-foundation-v1`。

**禁止：** 宣称 D1–D15 / 互联完成；L5–L8 真机；重编 `.so`；WebDAV 多写；Agent 本机系统权限；activityEvent 扩面；registry 增加新类型；用 KIND/mock/reference 绿灯冒充产品完成；git commit/push；截断现有大文件；改规范正文 D1–D15；发明第二套协议。

P0 已有、不得回退：Desktop CAS base 0 / confirmedBase、cursor 不跟 push serverCursor、删除入队、坏信封 abort、pending overlay 不被覆盖、换绑隔离、overlap 父子路径、空 ledger fail-closed、bootstrap SQLite 快照、shared serializeShared、wake sqlite lease、Go 1.26.10 pin。

五类闭环：`connection` `proxy` `sshKey` `jumpHost` `note`。

## 文件所有权（禁止跨组改同一生产文件）

| 组 | 可改 |
|---|---|
| A | `zephyr-one-link-sync.js`、`tests/zephyr-one-link-sync.test.mjs`；可新建 `one-link-local-store.js`、`tests/one-link-local-store.test.mjs` |
| B | `mobile-v1-store.js`、`mobile-v1-routes.js`；可新建下列测试。**禁止改 server.js** |
| C | `resource-service.js`、`notes-service.js`、`mobile-v1-change-bridge.js`、`server.js`（只给 `createZephyrOneLinkSync` 加 `db: storage.rawDb()` 这一处）、`tests/mobile-v1-change-bridge.test.mjs` 追加、可新建 `tests/owned-mutation-outbox-atomic.test.mjs` |

## A — Desktop staging / conflict / secret journal / outbox 闭环

当前缺口（相对 §5 / §4 永久回归）：

1. **SYNC-OUT-005**：业务行在 SQLite，outbox 在 JSON 文件，`onOwnedMutation` 在 change-bridge 事务提交之后才调（且被 try/catch 吞掉）。本组把 Desktop 本地同步状态迁到 **同一 SQLite**（`storage.rawDb()` / 构造参数 `db`）。无 `db` 时保留现有 JSON，供内存单测。
2. **bootstrap staging（SYNC-CUR-004）**：`_bootstrapAll` 现在逐页 `_applyRemoteChange` 直接写可见镜像。改为写入 `one_link_bootstrap_staging`；全部页成功后 **一个事务 promote** 到 adapter；失败/过期/中断不得污染旧镜像。token 过期丢 staging 并整代重拉。
3. **secret journal（SYNC-SEC-003/004）**：对齐 Android `SecretMutationJournal` 语义（不必抄 Kotlin）：`(accountKey, opId, entityType, entityId, fieldName)` 的 put/clear 记录，状态 `prepared|applied|acked|superseded`。密封/写入密钥前先 journal；崩溃恢复不得丢明文到日志、不得跨账号 ref。密钥不可用时 defer（已有 SYNC-SEC-005）而不是 envelope-less 上传。
4. **冲突合同（SYNC-CON-003/007/008/009/010）**：
   - 冲突行必须保存 `base / baseRevision / local / server / mergedPayload`，不是只有 reason 字符串。
   - 同字段默认保留冲突，禁止墙钟 LWW 覆盖。
   - 不同字段自动合并（P0 `_mergeRemoteUnderPending` 保留并覆盖测试）。
   - 笔记 `content`：base/local/server 都可证明时做行级 diff3；有未解决 hunk 则冲突，禁止伪 merge。
   - `COPY_AS_NEW` 必须 `crypto.randomUUID()`，禁止 `id-copy`。
   - 远端 delete + 本地 pending upsert：删除优先；本地编辑变成冲突副本（新 UUID），不得静默丢本地。
   - 解决 keep_local / keep_server / manual_merge：新 opId、正确新 baseRevision、真实 mergedPayload。
5. **cursor/ACK（SYNC-CUR-002/003）**：一页内所有 adapter 写入 + `appliedCursor` 同一 SQLite 事务；事务未提交则 cursor 不动。ACK 失败只让 `ackedCursor` 落后，恢复后重 ACK，不重放副作用。
6. **SYNC-OUT-003**：pending > 200 时按 `MAX_OPS_PER_BATCH=200` 分批；依赖顺序 `sshKey/proxy/jumpHost` 先于引用它们的 `connection`，note 独立。同 opId 重试。
7. **enqueue 字段**：op 保存 action、baseRevision、真实 fieldMask、secret mutation、createdLocally、dispatchedAt、attemptCount。accepted/duplicate 才 done；rejected 保持 pending + lastError；conflict 进冲突表。

建议表名（都带 `one_link_` 前缀，additive）：

- `one_link_outbox`
- `one_link_conflicts`
- `one_link_secret_journal`
- `one_link_bootstrap_staging`
- `one_link_meta`（cursors / bootstrap / bindingGeneration / mirrorEpoch / accountKey）
- 可选 `one_link_server_mirror`（每实体最后确认的 canonical JSON，供三方比较；不要把 overlay 写进 mirror）

`recordLocalMutation` 在有 `db` 时必须写 SQLite outbox 且失败要 **抛错**（给 C 组事务回滚用）。无 db 时保持现 JSON 行为。

enqueue upsert 时把当时的 confirmed payload 快照进 op（note 的 `content` 尤其需要），否则 diff3 没有 base。

测试必须覆盖（用户结果，不只“没抛错”）：

- SYNC-OUT-005：有 db 时，模拟 outbox insert 失败，canonical 行不得提交（与 C 配合；A 至少单测 store.rollback）。
- SYNC-CUR-002：pull 页中途 throw，appliedCursor 与镜像仍是页前状态。
- SYNC-CUR-003：apply 成功、ACK throw，applied 前进、acked 不动，下次只 ACK。
- SYNC-CUR-004：bootstrap 中断后旧镜像完整，resume 用 staging；token 过期重建。
- SYNC-OUT-003：201 ops 分成 2 批，依赖顺序正确。
- SYNC-CON-003：同字段冲突对象含 base/local/server。
- SYNC-CON-007：笔记不同段可合、同段未解决 hunk 可见。
- SYNC-CON-008：连续两次 COPY_AS_NEW，两个不同 UUID，都不等于 `id-copy`。
- SYNC-CON-009：远端删 + 本地 pending 编辑 → 本地以新 UUID 副本存在。
- SYNC-CON-010：keep_local 产生新 opId 且 baseRevision 为 server revision。
- SYNC-SEC-004：journal prepared 后崩溃，恢复后密钥与 journal 一致。
- 保留全部现有 P0 测试名称与断言。

跑：`node --test tests/zephyr-one-link-sync.test.mjs tests/one-link-local-store.test.mjs`

## B — 主端 ledger 回填 / 变更 GC / 已知类型投影失败不得 skip

当前缺口：

1. `pruneChangesBefore` / `gcAppliedOps` / `gcBootstrapSnapshots` 已实现，**没有定时跑**。`mobile_change_outbox` 已投递行永不删。
2. 空 field ledger fail-closed 已有，但 **没有从 canonical 行回填**。历史库会永远冲突。
3. `hydrateChange`：无 adapter → `unsupported: true`（未知类型，允许）。**已知类型** `adapter.read`/`projectPayload` 抛错也不得 `unsupported: true` 跳过并推进 cursor（SYNC-CUR-006）。缺行（已删除、后面有 tombstone）保持现有 skippable 行为，避免冻 cursor。
4. wake 已是 SQLite lease（P0）。本组补 **已投递 outbox GC**，不要改 lease 协议。

必须做：

- `CHANGE_RETENTION_DAYS = 180`（与 tombstone 一致）。新增 `pruneChangesOlderThan(ownerUserId, cutoffMs)`：按 `changed_at` 找到该 owner 可裁剪的最大 seq，再调现有 `pruneChangesBefore`。裁剪后 `isCursorExpired` 必须对落后 cursor 返回 true；`executeChangesForDevice` 已抛 `cursor_expired`。
- `gcDeliveredWakeOutbox({ olderThanMs })`：只删 `delivered_at IS NOT NULL` 且足够旧的行，禁止删未投递。
- `MobileV1Api.runMaintenance(now)`：对每个在 `mobile_entity_versions` 或 `mobile_change_retention` / 变更表出现过的 owner 做 prune；`gcAppliedOps`；`gcBootstrapSnapshots`；wake 投递 GC。`constructor` 里 `setInterval` 1h 且 `unref()`。新增 `close()` 清 timer（`server.js` 已 `api.close?.()`）。
- `backfillFieldLedger({ ownerUserId, entityType, entityId, fields, revision, changedAt })` 或 API 级 `backfillFieldLedgers()`：仅当该实体 **ledger 为空** 且 canonical adapter 能读到行时，把 **当前** editable+secret 字段写成当前 entity revision（这是“无法证明字段历史 → 以当前投影为基线”，不是伪造更早历史）。已有 per-field 行不得覆盖。构造末尾对五类已接线 adapter 做一次（失败 log，不抛垮启动）。
- hydrate：`spec` 与 `adapter` 都在，且 `adapter.read` 抛非缺行错误，或 `projectPayload` 抛错 → `MobileStoreError('sync_projection_failed', ..., 500)`，整页失败，`nextCursor` 不得前进。未知类型仍 `unsupported: true`。

测试：

- 180 天前的 change 被 prune，落后 cursor 变 `cursor_expired`；窗口内 change 保留。
- 未投递 wake 行不被 GC；已投递且过期被删。
- 空 ledger + 现存 connection 回填后，不相交字段 `hasOverlap` 为 false；相交字段仍 true。
- 已知类型 projection throw → changes 接口 500/error，cursor 不变；未知类型仍 unsupported。
- 现有 overlap / bootstrap snapshot / dispatcher 测试必须继续绿。

跑：`node --test tests/mobile-v1-gc-retention.test.mjs tests/mobile-v1-field-ledger-backfill.test.mjs tests/mobile-v1-hydrate-projection.test.mjs tests/mobile-v1-field-overlap.test.mjs tests/mobile-v1-bootstrap-snapshot.test.mjs tests/mobile-v1-outbox-dispatcher.test.mjs`

改 `mobile-v1-routes.js` 用精确替换，禁止重写整文件。`ensureSchema` 只允许 ADDITIVE。

## C — 业务写入与 outbox 同一 SQLite 事务

根因：`ResourceService._runMobileMutation` / `NotesService._runMobileMutation` 在 `changeBridge.runMutation` **返回之后** 才 `_emitOwnedMutation`，而 emit 自己又 swallow error。`server.js` `notifyOwnedLinkMutation` 同样 try/catch。这直接违反 SYNC-OUT-005。

必须做：

1. `MobileV1ChangeBridge.runMutation` 在 **同一 `db.transaction`** 里：`write()` → `recordMutation` → 若 `meta.insideTx` 是函数则调用（可把 result/after 传入）。`insideTx` 抛错必须让整笔事务回滚（含 canonical 行和 feed）。
2. Resource/Notes 的 `_runMobileMutation` 把 `_emitOwnedMutation` 挪进 `insideTx`（或等价地让 emit 发生在 transaction 内）。**删掉 emit 的 swallow catch**（至少在会写 Link outbox 时）；hook 失败必须回滚。
3. ephemeral connection 仍跳过 emit（已有）。
4. `remoteMerge === true` 仍不入 Desktop outbox。
5. `server.js` `createZephyrOneLinkSync({ ..., db: storage.rawDb() })` 只改这一处调用。`notifyOwnedLinkMutation` 去掉吞异常的 catch（让事务回滚）；`!ZEPHYR_ONE_EMBEDDED` / 无 sync / 无 binding 仍直接 return。
6. restore 路径：Notes `restore` 已走 mutation 的保持 upsert emit。不要漏 restore。

测试（真实 better-sqlite3 temp db，不要 mock 掉事务）：

- note/connection create 成功 → 在 **同一 commit** 后能读到行，且 `insideTx` 被调用。
- `insideTx` throw → 行不存在、无 change feed 行。
- `remoteMerge: true` 不调用 Desktop enqueue（可用计数器）。
- 现有 change-bridge 测试全绿，尤其 “feed failure rolls the canonical write and wake event back together”。

跑：`node --test tests/mobile-v1-change-bridge.test.mjs tests/owned-mutation-outbox-atomic.test.mjs tests/zephyr-one-link-sync.test.mjs`（后者只确认 C 没破坏 P0 的 onOwnedMutation 测试；若 A 同时改该文件，以不破坏 ResourceService/NotesService 那两个 test 为准）。

## 完成后各组必须交回

- 改了哪些文件（git diff --stat）
- 新增测试名与结果（pass/fail 计数）
- 明确没做的回归编号
- 任何对所有权文件的越界
