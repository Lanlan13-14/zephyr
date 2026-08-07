# Zephyr One 完整双向同步状态机

> [KNOWN] Zephyr 业务语义来源：`resource-service.js`、`notes-service.js`、`authz.js`、`workspace-service.js`、`user-settings-service.js`、`file-agent-manager.js`。
>
> [INFERRED] 本文冻结 mobile v1 的客户端顺序、持久化点和崩溃恢复；它替换 `DEVELOPMENT.md` 中分散的 bootstrap/push/pull 描述。

## 1. 持久状态

```text
UNBOUND
BOUND_NEEDS_BOOTSTRAP
BOOTSTRAPPING
CATCHING_UP
IDLE
RUNNING
CONFLICTED
REAUTH_REQUIRED
REVOKED
FATAL_INCOMPATIBLE
```

[INFERRED] DB 中按 `(serverId, userId, deviceId)` 保存：

```text
bindingState
registryHash
bootstrapId / bootstrapPageToken / bootstrapSnapshotCursor
appliedCursor / acknowledgedCursor
activeRunId / activeRunStartedAt
lastAttemptAt / lastSuccessAt / lastError
rerunRequested
```

[KNOWN] access/refresh credential、设备私钥和业务 secret 不放该表，只存 SecretStore 引用。

## 2. 运行时阶段

```text
VALIDATE_BINDING
RECOVER_BOOTSTRAP
BOOTSTRAP_PAGE
CATCH_UP_PULL
PUSH_PENDING
PULL_CHANGES
APPLY_BLOBS
ACK_CURSOR
COMMIT_SUCCESS
```

- [INFERRED] 同一 binding 同时只能有一个 actor；新触发只写 `rerunRequested=true`。
- [INFERRED] 每轮结束后若 rerunRequested=true，清 flag 并再跑一轮；连续触发最多形成“当前轮 + 一次尾随轮”。
- [INFERRED] 手动同步不受 automaticEnabled 影响；只受绑定是否 live 影响。

## 3. 首次绑定顺序

```text
1 VALIDATE_BINDING / registry
2 BOOTSTRAP_PAGE until complete
3 persist snapshotCursor and mark BOUND snapshot installed
4 CATCH_UP_PULL from snapshotCursor until hasMore=false
5 PUSH_PENDING collected during bootstrap
6 PULL_CHANGES again until hasMore=false
7 APPLY_BLOBS
8 ACK_CURSOR
9 COMMIT_SUCCESS → IDLE
```

- [INFERRED] bootstrap 使用服务端固定 `snapshotCursor`；分页中途产生的新变化留在 change feed，不混入后续 bootstrap 页。
- [INFERRED] bootstrap 每页包含稳定 `bootstrapId` 和不可伪造 `nextPageToken`；token 默认 30 分钟过期，过期从空本地 staging 表重新开始。
- [INFERRED] bootstrap 写入 staging tables，不逐页污染 live mirror；complete 页到达后在一个本地事务中切换 generation。
- [INFERRED] bootstrap 期间本地新建/编辑只写 live overlay + PendingOperation，不发送；切换 generation 时 overlay 覆盖 staging 的同 entity，并保留其 baseRevision。
- [INFERRED] 首次必须先 catch-up 再 push，防止在陈旧 snapshot 上提交；push 后再次 pull，保证包含服务端给本设备生成的 canonical revision。

## 4. 普通同步顺序

```text
1 VALIDATE_BINDING / registry
2 PUSH_PENDING (dependency topology, max 200 ops/batch)
3 PULL_CHANGES until hasMore=false
4 APPLY_BLOBS
5 ACK_CURSOR
6 COMMIT_SUCCESS
```

[INFERRED] 普通轮次先 push 是为了缩短本地编辑可见时间；`baseRevision` 和服务端 conflict 判定保证它不会覆盖未知远端编辑。若服务端返回 `cursor_expired`，立即转 `BOUND_NEEDS_BOOTSTRAP`，不得继续 push。

## 5. 本地写入事务

```text
BEGIN IMMEDIATE
  read current entity + revision
  validate local field constraints
  write optimistic local entity
  insert PendingOperation(opId, entityType, entityId, action,
                          baseRevision, fieldMask, payload,
                          createdAt, attemptCount=0)
COMMIT
signal sync actor
```

- [KNOWN] `fieldMask` 只包含用户实际修改的 editable fields；masked secret、serverAuthority、opaque 和 deviceLocal 字段不能出现。
- [INFERRED] 同实体未发送操作可折叠：create+updates → one upsert；create+delete → remove both；updates → merge masks keeping oldest baseRevision；delete dominates later stale edits。
- [INFERRED] 已发送但结果未知的 op 不生成新 opId 重试；必须以原 opId 重放。

## 6. 服务端 push 事务

```text
BEGIN IMMEDIATE
  lookup mobile_applied_ops(ownerUserId, deviceId, opId)
  if exists → return stored logical result
  validate binding, registry, entity, capability, fieldMask
  load current entity + revision + field_revision_map
  decide accept / merge / conflict / dependency_missing / reject
  call canonical Zephyr business service
  write entity revision + field revision entries
  insert mobile_sync_changes in same transaction
  insert mobile_applied_ops(result)
COMMIT
```

- [KNOWN] 不允许 mobile sync 直接绕开 service 写业务表。
- [INFERRED] `mobile_applied_ops` 至少保留“最大允许离线重试期 + 30 天”，首版冻结为 180 天；保留期变更必须同步 capabilities。
- [INFERRED] op 结果包含完整逻辑结果；重放 100 次返回同 status/revision/changeSeq，不重复审计、通知或 Token 旋转。

## 7. 字段合并需要的数据

[INFERRED] 服务端增加：

```sql
CREATE TABLE mobile_entity_field_revisions (
  owner_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, entity_type, entity_id, field_path)
);

CREATE INDEX idx_mobile_field_revision_entity
ON mobile_entity_field_revisions(owner_user_id, entity_type, entity_id, revision);
```

[INFERRED] 判定：

```text
baseRevision == currentRevision → accept
baseRevision > currentRevision → reject invalid_revision
baseRevision < tombstoneRevision → conflict(delete wins)
any incoming field has fieldRevision > baseRevision → conflict
otherwise → merge patch onto current canonical entity
```

- [INFERRED] object/array 默认作为一个原子 field path；只有 registry 明确声明可拆分时才允许 `rdp.quality` 这类子路径。
- [KNOWN] secret 字段原子冲突；Note content、route dependency、ACL 和 Token secret 不做静默 last-write-wins。

## 8. Change feed 应用

```text
BEGIN IMMEDIATE
  assert page.fromCursor == appliedCursor
  for change ordered by changeSeq:
    verify entity registry and ACL projection
    if revision <= local serverRevision: skip canonical body, keep overlay
    else apply upsert/tombstone to mirror
    rebase or conflict pending local operations
  appliedCursor = page.nextCursor
COMMIT
```

- [INFERRED] cursor 与一页业务变更处于同一事务；崩溃只能发生在“整页都没提交”或“整页和 cursor 都提交”。
- [INFERRED] 自己 push 的 change 仍会进入 feed；按 revision/changeSeq 去重，不依赖服务端过滤 actorDeviceId。
- [KNOWN] ACL 撤销 change 优先应用：立即移除 secret、终止对应会话授权、将工作区 tab 标记 `resource_revoked`。
- [INFERRED] 不认识的 entityType 在最低兼容版本内是 fatal registry mismatch；已声明 opaque 类型保存原始 canonical JSON，不开放编辑。

## 9. 冲突

| 类型 | 处理 |
| --- | --- |
| [KNOWN] revision/field overlap | [INFERRED] 本地记录 conflict；保留 server、本地和 base 三份 |
| [KNOWN] Note content | [INFERRED] 可尝试三方文本合并；失败生成冲突副本 |
| [KNOWN] Secret | [INFERRED] 不自动拼接；选择一侧后重新 envelope |
| [KNOWN] Delete vs edit | [INFERRED] tombstone 胜；恢复作为新 revision，不撤销历史删除 |
| [KNOWN] ACL | [KNOWN] 服务端权限权威；不能“保留本机”覆盖撤销 |
| [KNOWN] append-only Activity | [KNOWN] eventId 去重，无可编辑冲突 |
| [KNOWN] Token rotate/delete | [INFERRED] 服务端事务权威；受影响 binding 立即失效 |

[INFERRED] UI 操作：使用服务端、保留本机、复制为新项、手工合并。每个选择产生新的 opId 和当时最新 baseRevision；不能修改旧冲突 op 的身份后重放。

## 10. Tombstone 和 retention

- [KNOWN] Note 已有 soft delete/restore；其他业务实体目前多为 hard delete，mobile v1 上线前必须加 tombstone。
- [INFERRED] tombstone 至少保存 `entityType/entityId/ownerUserId/deletedRevision/deletedAt/deletedBy/lastKnownName`，不保存秘密。
- [INFERRED] 首版 tombstone retention 冻结为 180 天，且不得短于 capabilities 声明的最大离线窗口。
- [INFERRED] 设备 `lastAckedCursor` 早于即将 GC 的最老 change 时，设备下次同步必须收到 `cursor_expired` 并重新 bootstrap。
- [INFERRED] 永久删除敏感实体的物理清理和 change/tombstone GC 分离；审计只留非秘密 metadata。

## 11. Blob

- [INFERRED] 大附件/备份不进入 JSON change payload；实体只携带 content-addressed manifest：`sha256,size,mime,chunks,encrypted`。
- [INFERRED] chunk 默认 4 MiB，服务端 capabilities 可下调；每块校验 SHA-256，最终校验整 blob。
- [INFERRED] 上传使用稳定 uploadId 和幂等 chunk index；断线只补缺块。
- [INFERRED] 下载先写临时文件，整体验证后原子 rename；错误 hash 删除临时文件并返回 `blob_hash_mismatch`。
- [KNOWN] local SAF URI/iOS bookmark 是 deviceLocal，只同步“需要该文件/目录”的产品意图。

## 12. 崩溃恢复矩阵

| 崩溃位置 | 重启行为 |
| --- | --- |
| [INFERRED] 写 entity 前 | 无状态，重新执行用户操作 |
| [INFERRED] entity 与 pending op 事务中 | SQLite 回滚，两者都不存在 |
| [INFERRED] push 已发、响应未存 | 用同 opId 重放，服务端返回首次结果 |
| [INFERRED] 服务端业务写后、change 前 | 禁止出现；同一事务回滚 |
| [INFERRED] change page 应用中 | 本地事务回滚，重拉同页 |
| [INFERRED] page commit 后、ack 前 | 从 persisted appliedCursor 继续，ack 可重放 |
| [INFERRED] bootstrap staging 中 | 用 bootstrapId/pageToken 恢复；过期清 staging 重来 |
| [INFERRED] blob 分块中 | 查缺块续传，不重传已验证块 |
| [INFERRED] Token rotation 请求未知 | 原 grant/opId 查询结果；禁止直接再旋转一次 |

## 13. 状态转移

| 当前 | 事件 | 下一状态 |
| --- | --- | --- |
| `UNBOUND` | bind success | `BOUND_NEEDS_BOOTSTRAP` |
| `BOUND_NEEDS_BOOTSTRAP` | run | `BOOTSTRAPPING` |
| `BOOTSTRAPPING` | snapshot complete | `CATCHING_UP` |
| `CATCHING_UP` | pull/push/pull success | `IDLE` |
| `IDLE` | trigger | `RUNNING` |
| `RUNNING` | success | `IDLE` |
| `RUNNING` | conflict only | `CONFLICTED`（同步其余实体继续） |
| any bound | SID expired | 数据面不变；管理面要求登录 |
| any bound | refresh invalid/token missing | `REAUTH_REQUIRED` |
| any bound | device revoked/account unavailable | `REVOKED` |
| any bound | protocol/registry incompatible | `FATAL_INCOMPATIBLE` |
| `CONFLICTED` | all conflicts resolved | `IDLE` |
| `REAUTH_REQUIRED` | successful rebind | `BOUND_NEEDS_BOOTSTRAP` |

## 14. 调度

- [KNOWN] interval 范围 30 秒～24 小时。
- [KNOWN] 前台按用户目标精确触发；后台由系统调度，UI 同时显示“目标间隔”和“实际上次同步”。
- [INFERRED] Android 15 分钟及以上使用 periodic WorkManager；更短后台间隔只有用户明确开启持续同步时使用 foreground service。
- [COMMON] iOS BGTask 不保证固定间隔；短间隔仅前台有效，后台靠 BGAppRefresh/BGProcessing、silent push 和回前台补偿。
- [INFERRED] retry backoff：1s、2s、4s、8s、16s、30s、60s、最大 15min，加入 0.5–1.5 jitter；429 优先 Retry-After。

## 15. 必测不变量

1. [KNOWN] 同 opId 重放 100 次只产生一次业务副作用。
2. [INFERRED] 任一 crash point 后实体、pending op、cursor 不产生半事务。
3. [INFERRED] 字段不重叠自动合并，重叠稳定冲突。
4. [KNOWN] ACL 撤销和 tombstone 不被离线设备复活。
5. [KNOWN] masked/unknown/opaque/serverAuthority 字段不进入 One fieldMask。
6. [KNOWN] 每个 entity registry 项自动跑 bootstrap/push/pull/delete/restore/conflict/secret/unknown-field。
7. [INFERRED] Web + Android + iOS 三方写入都生成同一 change feed。
8. [KNOWN] 自动关闭不影响手动“立即同步”。
