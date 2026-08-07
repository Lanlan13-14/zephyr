# Zephyr One 原生数据、服务端扩展与迁移合同

> [KNOWN] Zephyr 事实源：`storage.js`、`secret-crypto.js`、`session-store.js`、`one-client-manager.js`、`file-agent-manager.js`、`ai-provider-service.js`。
>
> [INFERRED] 本文冻结新增表、事务和迁移门；具体 Room/GRDB migration 文件必须与本文逐版本一致。

## 1. 三类数据

| 类别 | 权威位置 | 示例 |
| --- | --- | --- |
| 账号镜像 | [INFERRED] Zephyr service + mobile change log；One 是 local-first replica | connection/note/snippet/AI settings/token/workspace |
| 设备本地 | [KNOWN] One 本机 | SAF URI、security-scoped bookmark、设备密钥、active socket、scroll position |
| opaque preservation | [INFERRED] 服务端 canonical snapshot/One 原样保存 | 新版本未知字段、customCssJs、无移动用途后台字段 |

[KNOWN] 不可把设备身份私钥、refresh credential、数据库 master key、SID、系统授权句柄同步给其他设备。

## 2. 服务端新增 DDL

```sql
CREATE TABLE mobile_devices (
  device_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_username_compat TEXT NOT NULL,
  token_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
  app_version TEXT NOT NULL,
  encryption_public_key BLOB NOT NULL,
  signing_public_jwk TEXT NOT NULL,
  refresh_token_hash TEXT,
  refresh_generation INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  automatic_enabled INTEGER NOT NULL DEFAULT 1,
  sync_interval_sec INTEGER NOT NULL DEFAULT 300,
  registry_hash TEXT NOT NULL,
  last_acked_cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX idx_mobile_devices_owner
  ON mobile_devices(owner_user_id, created_at DESC);
CREATE INDEX idx_mobile_devices_token
  ON mobile_devices(token_id, revoked_at);

CREATE TABLE mobile_entity_versions (
  owner_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, entity_type, entity_id)
);

CREATE TABLE mobile_entity_field_revisions (
  owner_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, entity_type, entity_id, field_path)
);
CREATE INDEX idx_mobile_field_revision_entity
  ON mobile_entity_field_revisions(owner_user_id, entity_type, entity_id, revision);

CREATE TABLE mobile_sync_changes (
  change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  revision INTEGER NOT NULL,
  field_mask_json TEXT NOT NULL DEFAULT '[]',
  actor_device_id TEXT,
  changed_at INTEGER NOT NULL,
  tombstone_json TEXT
);
CREATE INDEX idx_mobile_changes_owner_seq
  ON mobile_sync_changes(owner_user_id, change_seq);
CREATE INDEX idx_mobile_changes_entity
  ON mobile_sync_changes(owner_user_id, entity_type, entity_id, revision);

CREATE TABLE mobile_applied_ops (
  owner_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, device_id, op_id)
);
CREATE INDEX idx_mobile_applied_ops_expiry ON mobile_applied_ops(expires_at);

CREATE TABLE mobile_sync_runs (
  run_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  from_cursor INTEGER NOT NULL,
  to_cursor INTEGER,
  pushed INTEGER NOT NULL DEFAULT 0,
  pulled INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  request_id TEXT
);
CREATE INDEX idx_mobile_sync_runs_device
  ON mobile_sync_runs(device_id, started_at DESC);

CREATE TABLE client_tokens (
  token_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_username_compat TEXT NOT NULL,
  name TEXT NOT NULL,
  token_secret_enc TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX idx_client_tokens_owner
  ON client_tokens(owner_user_id, deleted_at, created_at DESC);

CREATE TABLE mobile_sensitive_grants (
  grant_hash TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);
CREATE INDEX idx_mobile_sensitive_grants_expiry
  ON mobile_sensitive_grants(expires_at, consumed_at);
```

- [INFERRED] 所有表由版本化 migration 建立；生产启动逻辑不得继续无限堆叠未编号 `addColumnIfMissing`。
- [INFERRED] 每次业务 service 写入与 `mobile_entity_versions/field_revisions/sync_changes` 在同一个 SQLite transaction。
- [INFERRED] `mobile_sync_changes` 不存 secret 明文或完整 secret ciphertext；响应时按目标设备生成 envelope。

## 3. Token 明文 JSON 迁移

### 3.1 输入事实

- [KNOWN] 当前 `data/agent-tokens.json` v2 是 `{version:2,tokens:[{id,ownerId,name,token,...}]}`，`ownerId` 使用 username，token 是明文。
- [KNOWN] `storage.js` 已有 immutable userId；`secret-crypto.js` 已有 ML-KEM-768 + AES-256-GCM 字段加密。

### 3.2 单次事务

```text
1 acquire exclusive token migration lock
2 read and strictly validate agent-tokens.json v2 / legacy map
3 resolve ownerId username → immutable users.userId
4 for each token:
    preserve token_id/name/timestamps
    encrypt token with AAD clientToken:<tokenId>:token
    insert client_tokens revision=1
5 compare counts and decrypt every inserted token in memory
6 write meta.clientTokensMigratedAt + source sha256
7 COMMIT
8 rename source to agent-tokens.pre-sqlite.<timestamp>.json
9 chmod 0600; do not continue dual-write
```

- [INFERRED] 任一 owner 无法解析、重复 tokenId、重复 secret 或解密回验失败时整个事务回滚，原 JSON 保持原位。
- [INFERRED] 迁移后旧 Agent 验证从 SQLite 读取并只在内存构建 hash/index；不得把明文重新写回磁盘。
- [KNOWN] username 改名后归属继续跟随 userId；`owner_username_compat` 仅用于旧协议展示。

## 4. One 本地 SQLite 逻辑表

[INFERRED] Android Room 和 iOS GRDB 使用相同逻辑 schema；列名可平台化，但 migration fixture 必须映射一致。

```sql
CREATE TABLE bindings (
  binding_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  sid_secret_ref TEXT,
  access_secret_ref TEXT,
  refresh_secret_ref TEXT,
  registry_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  applied_cursor INTEGER NOT NULL DEFAULT 0,
  acknowledged_cursor INTEGER NOT NULL DEFAULT 0,
  bootstrap_id TEXT,
  bootstrap_page_token TEXT,
  bootstrap_snapshot_cursor INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  automatic_enabled INTEGER NOT NULL DEFAULT 1,
  interval_sec INTEGER NOT NULL DEFAULT 300,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(server_id,user_id,device_id)
);

CREATE TABLE mirror_entities (
  binding_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  server_revision INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  opaque_json TEXT NOT NULL DEFAULT '{}',
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(binding_id,entity_type,entity_id)
);
CREATE INDEX idx_mirror_entities_list
  ON mirror_entities(binding_id,entity_type,deleted_at,updated_at DESC);

CREATE TABLE pending_operations (
  binding_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  batch_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  field_mask_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  in_flight_at INTEGER,
  PRIMARY KEY(binding_id,op_id)
);
CREATE INDEX idx_pending_ops_order
  ON pending_operations(binding_id,created_at);

CREATE TABLE conflicts (
  binding_id TEXT NOT NULL,
  conflict_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  base_json TEXT,
  local_json TEXT NOT NULL,
  server_json TEXT NOT NULL,
  conflicting_fields_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);

CREATE TABLE secret_records (
  secret_ref TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  aad BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(binding_id,entity_type,entity_id,field_name)
);

CREATE TABLE device_grants (
  grant_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  platform_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  read_only INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE blob_transfers (
  transfer_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  direction TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  completed_chunks_json TEXT NOT NULL,
  temp_ref TEXT,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [INFERRED] 类型化 feature 表可以从 `mirror_entities.canonical_json` 投影，也可物理拆表；无论选择哪种，canonical revision/opaque/pending 不得出现两个真源。
- [KNOWN] secret 表不得进入 Android Auto Backup/iCloud device backup；业务 secret 的跨设备恢复只走 mobile envelope。

## 5. SecretStore

### 5.1 Zephyr 现有服务器静态加密

- [KNOWN] `secret-crypto.js` 使用 ML-KEM-768 encapsulation，HKDF-SHA256，AES-256-GCM，12-byte IV，独立 16-byte tag。
- [KNOWN] 服务器密钥文件默认 `data/crypto/ml-kem-768-keypair.json`，secret key 2400 bytes，public key 1184 bytes；可由环境变量提供。
- [KNOWN] 这套格式用于服务器静态字段，不直接等于设备传输 envelope。

### 5.2 设备 envelope v1

- [INFERRED] 为复用 Zephyr 已采用的后量子 primitive，设备加密公钥固定为 ML-KEM-768；设备另生成 P-256/ES256 signing key 做 request proof。
- [INFERRED] `alg = ML-KEM-768+HKDF-SHA256+AES-256-GCM`。
- [INFERRED] HKDF：

```text
salt = SHA-256(UTF8("zephyr-mobile-envelope-v1"))
info = AAD bytes
length = 32
```

- [INFERRED] AAD 是以下 UTF-8 字段用单个 NUL `0x00` 连接，数字使用无前导零十进制 ASCII：

```text
zephyr-mobile-secret-v1
serverId
userId
deviceId
entityType
entityId
fieldName
entityRevision
keyVersion
```

- [INFERRED] JSON 中 `ct/iv/tag/data/aad` 使用标准 Base64（有 padding）；canonical test vector 在 `contracts/test-vectors/sync-v1.json`。
- [INFERRED] 解密前必须逐字段重建 AAD 并 constant-time 比较 envelope.aad；entityRevision/keyVersion 不匹配则拒绝。
- [INFERRED] Android：ML-KEM private key 由 Keystore AES-GCM wrapping key 包裹；ES256 signing key 直接不可导出生成在 Keystore。iOS：ML-KEM private key 由 ThisDeviceOnly Keychain wrapping key 包裹；P-256 signing key 优先 Secure Enclave。
- [INFERRED] rooted/jailbroken 环境只显示风险，不改变服务器 ACL，也不声称绝对防提取。

## 6. Server DB migration 版本

| 版本 | 内容 | 回滚 |
| --- | --- | --- |
| `mobile_0001` | [INFERRED] devices、entity versions、field revisions、changes、ops、runs | [INFERRED] 无客户端绑定时可 drop；有数据时只 forward-fix |
| `mobile_0002` | [INFERRED] client_tokens 加密表 + JSON 导入 | [INFERRED] 可从保留 JSON 恢复，但禁止自动降级双写 |
| `mobile_0003` | [INFERRED] sensitive grants、refresh generation/proof | [INFERRED] 撤销全部 mobile credential 后 forward-fix |
| `mobile_0004` | [INFERRED] 各业务 service revision/tombstone/change hooks | [INFERRED] 不可丢 change history；从 DB pre-migration backup 整体回滚 |
| `mobile_0005` | [INFERRED] AI/Snippet/settings 正规化 | [INFERRED] 保留 legacy JSON 只读镜像一个版本周期 |

- [KNOWN] 每次 migration 必测：空库、当前生产库、重复执行、崩溃中断、回滚/恢复、10k/100k 数据规模。
- [INFERRED] migration 前执行 WAL checkpoint + 在线备份 API，不直接复制活跃 WAL DB 文件。

## 7. Tauri One → 原生 One

### 7.1 输入

- [KNOWN] 旧 One 使用 Tauri + 本地 Zephyr core；绑定/SID/deviceToken/snapshot 曾进入 localStorage。
- [KNOWN] 这些 credential 不能原样成为新 device identity。

### 7.2 过渡导出

```json
{
  "format": "zephyr-one-native-migration",
  "version": 1,
  "sourceAppVersion": "...",
  "createdAt": 0,
  "serverProfiles": [],
  "bindings": [{"baseUrl":"...","username":"...","tokenId":"..."}],
  "entities": [],
  "secretEnvelope": "one-time encrypted payload",
  "hashes": {}
}
```

- [INFERRED] SID、deviceToken、设备私钥绝不导出；Client Token 和业务 secret 只进入一次性迁移 envelope。
- [INFERRED] 原生版导入后必须重新登录/绑定生成新 device keys，再由完整同步校准 revision。
- [KNOWN] SAF URI/iOS bookmark 必须重新授权。
- [INFERRED] 成功 marker 写入后迁移不可重复；加密源文件保留一个版本周期，由用户确认删除。

## 8. 备份恢复与 mobile sync 的关系

- [KNOWN] 主端完整备份恢复替换全 DB 和数据密钥，可能让所有 cursor/revision/device/token 回到过去。
- [INFERRED] 导入成功后服务端递增 `instanceEpoch`，撤销所有 mobile access/refresh，清空 change cursor 可用性，并要求所有 One 重新登录+bootstrap。
- [INFERRED] One 不允许用导入前 pending op 自动覆盖恢复后的主端；先导出本地未同步变更供用户确认，再重新 bootstrap。
- [INFERRED] 备份 metadata 进入同步，但备份 archive 本体只有用户显式下载时走 blob，不自动复制到所有设备。

## 9. 数据完整性门

1. [KNOWN] 新业务字段必须分类为 editableSync/opaquePreserve/deviceLocal/serverOnly。
2. [INFERRED] editable field 必须存在 field revision；secret field 必须有 AAD 和 test vector。
3. [KNOWN] 列表 payload 不含明文 secret；hasX/masked 语义与 Zephyr 一致。
4. [INFERRED] token JSON 迁移后磁盘扫描不得发现活动 token 明文。
5. [INFERRED] DB 导入/迁移/restore 任一失败均恢复旧 DB+key，并能重新打开服务。
6. [KNOWN] username 改名不改变 owner userId、ACL、device 或 token 归属。
7. [INFERRED] backup restore 改变 epoch 后旧 cursor/device proof 全部失效。
