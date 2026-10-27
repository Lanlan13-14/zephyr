# Zephyr Link 全端互联架构与工程规范

| 项目 | 内容 |
|---|---|
| 文档编号 | ZEPHYR-LINK-ARCH-001 |
| 文档版本 | 1.0.0 |
| 状态 | **Approved for Implementation / 已批准实施，非功能完成声明** |
| 决策日期 | 2026-10-26 |
| 规范基线 | `zephyr-newui@3796df32dbe8fe28376e45ff1e7ccf2080cc87c1` |
| 适用范围 | Zephyr 主端、One Desktop、Android、iOS、Agent、`zephyr-agentd`、WebDAV Vault、AI/Cell |
| 输入文档 | `ZEPHYR-UNIFIED-MASTER-PLAN.md`；Zephyr Link 同步审计与 Go 安全核查 |
| 测试与交付约束 | `TESTING-AND-RELEASE-GATES.md` 为本规范的强制组成部分 |

> 本文件把已确认的产品决策转成可实施合同。凡标为“目标/MUST”的内容，只有满足第 16 章验收矩阵、真实平台构建及发布门禁后，才可标为“已实现”。现有注册表、KIND、测试名、UI 入口、协议注释或 mock 通过均不构成完成证明。

---

## 1. 决策记录（D1–D15）

### 1.1 已批准决策

| 编号 | 决策 |
|---|---|
| D1 | 本地已有数据首次绑定时，默认**不自动上传**；先进入导入预览，用户按实体选择导入、仅保本地或冲突副本。 |
| D2 | 不默认自动 LWW。普通字段 CAS；不同字段自动合并；同字段保留冲突；笔记 diff3 + 副本。不得信任客户端墙钟决定覆盖权。 |
| D3 | 不全量重写客户端存储。保留 Android Room、iOS/Desktop SQLite；Go 统一密码学、协议编解码、WebDAV 与校验；合同测试向量统一。 |
| D4 | WebDAV 先实现独立密码 E2EE 备份/恢复，再开放多设备 OpLog。绑定主端后是独立灾备，不与主端形成双主循环。 |
| D5 | 撤销立即禁用在线能力；wipe 单独确认，只清 Linked 域及对应密钥，绝不清 Local。离线设备仅能在下次联网执行并回报审计。 |
| D6 | 新增 bound 实时互联统一走 ZSL/2；HTTPS 用于发现、绑定及显式兼容回退，回退必须可见。 |
| D7 | 先用 Go 1.26.10 做安全热修，`x/crypto` 至少 v0.56.0；所有 Go 二进制重编译、重发、扫描。Go 1.27.3 另行验证，不阻塞 CVE 修复。 |
| D8 | 主端信任边界按 lane 分级：WebDAV Vault 坚持零知识；主端锚定 Handoff/AI/端口转发/relay 明示 `trusted-primary`，不宣称内容零知识。 |
| D9 | 采用正式版本化 Link 帧合同：现有 KIND 冻结，业务 body 统一版本、requestId、幂等、TTL、能力、错误码与兼容向量。 |
| D10 | Android/iOS 的 Link/AI/Cell 合并为唯一 Go runtime：Android 单一 `libzephyr.so`，iOS 单一 `libzephyr.a`；平台 Repository/Room/SQLite 仍留在原生层。 |
| D11 | 第一阶段接受“单主/sticky + 可恢复重连”，不承诺内存会话天然 HA；需要在线迁移时另建 session state store + fencing。 |
| D12 | 同账号有效自有设备默认 `instant` 接力；跨用户、高危 AI、凭据 reveal、远程 wipe、非回环监听等必须显式审批。 |
| D13 | 跨端命令采用幂等 + 结果查询；流采用 epoch/seq；文件采用分块、窗口背压、checkpoint、取消和 SHA-256。 |
| D14 | Shared-to-me 坚持严格零落盘；主端代注凭据、一次性 PoP 票据、撤销即失效，不进入 owned 镜像与持久索引。 |
| D15 | **Agent 跨端能力由用户自定义，每台 Agent 均可在 Agent 所在端独立设置；最终授权裁决在 Agent 本机，主端只能申请、协调和审计。** |

### 1.2 D15 授权优先级（不得颠倒）

```text
Agent 本机用户策略（最终上限）
        ∩
主端授予调用者的 ACL（允许申请的上限）
        ∩
本次会话、资源、操作与平台权限
        =
实际允许能力
```

**必须取交集，不得取并集。** 主端角色为 admin、拥有 Owner 资源、设备已绑定、持有有效 token 或曾经获批，都不能扩大 Agent 本机用户设置的能力上限。

---

## 2. 架构总纲：Link 是互联底座，不是同步按钮

### 2.1 统一依赖链

```text
设备身份 / PoP / BindingGeneration
        ↓
账号、Workspace、Local / Owned / Shared 数据域
        ↓
ZSL/2 分通道 + 版本化业务帧合同
        ↓
Capability 授权 + Residency + 配额 + 审计
        ↓
Epoch / Seq / 幂等 / 背压 / Checkpoint
        ↓
撤销、崩溃恢复、重连与跨版本兼容
```

### 2.2 通道职责

| 通道 | 承载业务 | 数据/信任边界 |
|---|---|---|
| `control` | 能力发现、诊断、唤醒、撤销 | 不夹带业务秘密；必须按账号和设备鉴权 |
| `owned-sync` / `secret` / `blob` | Owned 实体、凭据封套、二进制对象 | 账号镜像；设备封套；不得混入 Shared-to-me |
| `file-bridge` | Agent 授权目录、VFS、文件传输 | Agent 本机授权裁决；主端协调 |
| `shared-terminal` / `shared-remote` | 共享 PTY、RDP/VNC 显示与输入 | `trusted-primary`；主端代注上游凭据，Sharee 零原始凭据 |
| `shared-note` / `shared-file` | 在线共享笔记/文件 | 纯在线、内存态、零落盘 |
| `ai` | AI dispatch、stream、approval、Cell RPC | 按执行位置划分本地/主端信任域；审批与工具结果绑定 |
| `agent-tunnel` | SSH 隧道、端口转发、TCP 字节流 | Agent 本机网络授权；默认回环，不做公网暴露 |

### 2.3 明确禁止的架构捷径

1. 禁止为每个新互联功能另造私有加密协议、身份体系、revision/cursor 语义。
2. 禁止把 KIND 编号存在当作业务协议完成。
3. 禁止把 ZSL/2 加密传输宣传为主端不可见内容的 E2EE。
4. 禁止通过把同步模型直接改成 Go SQLite，推翻 Android/iOS 已验证的平台事务层。
5. 禁止通过 UI 配置开关、schema 字段或源码正则测试冒充真实跨端闭环。
6. 禁止在主端远程部署时，以主端 `127.0.0.1` 冒充用户浏览器所在电脑的端口落点。
7. 禁止主端授予超过 Agent 本机策略的能力。

---

## 3. 身份、授权与数据驻留

### 3.1 身份元组

每个 durable binding 至少绑定：

```text
(serverId, userId, deviceId, bindingGeneration)
```

设备签名、设备加密公钥、平台、应用版本、registry hash 与撤销状态必须可验证。每个数据库、outbox、FTS、secret scope、bootstrap generation 均须按身份元组隔离。

### 3.2 三个数据域

| 域 | 持久化策略 | 凭据策略 | 离线策略 |
|---|---|---|---|
| Local | 本机独立数据库/密钥库；不上传 | 本机持有 | 可离线使用 |
| Owned / Linked | 按绑定身份隔离的加密镜像；允许 outbox | Owned 同步封套 | 可离线查看/编辑/直连 |
| Shared-to-me | **严格零落盘** | 主端代注；一次性 PoP 票据 | 仅在线，撤销或断网即失败 |

Shared 数据不得进入 SQLite/Room、SecretStore、FTS、最近记录、草稿、通知正文、崩溃转储、系统云备份或 owned 同步流。所有 shared 响应在统一序列化出口执行白名单、禁键扫描及 `no-store/private/no-cache`。

### 3.3 Capability 不等于自动授权

能力名称只是协议 vocabulary，实际允许值由以下来源共同决定：

- 账号/Owner ACL；
- 当前设备绑定与撤销状态；
- 当前资源 revision、share profile 与用途；
- Agent 本机独立策略；
- 操作系统授权（SAF、Security-Scoped Bookmark、目录选择器、网络权限）；
- 本次会话的 `view/use/edit/write/execute/share/revealSecret` 范围。

`KIND.AI` 或 `AGENT_TUNNEL` 可建立，不代表 AI 全工具、全盘文件或任意网络目标自动可用。

---

## 4. 正式 Link 帧与版本兼容合同

### 4.1 KIND 冻结

现有 KIND 数值和 channel 映射保持冻结：

```text
1 SYNC_OP       2 SYNC_ACK       3 BLOB_MANIFEST  4 BLOB_CHUNK
5 BLOB_HAVE     6 WAKE           7 RELAY          8 CONTROL
9 SECRET        10 FILE_BRIDGE   11 SHARED_TERMINAL
12 SHARED_REMOTE                 13 SHARED_NOTE   14 SHARED_FILE
15 AI           16 AGENT_TUNNEL
```

未注册 KIND 必须拒绝，不得默认映射到 control 或“尽力处理”。现有 KIND 仅表示通道，不代表其中业务 op 已全部实现。

### 4.2 新业务信封与现有协议的关系

**兼容边界必须先读懂，禁止直接替换现网报文：**

- 现有 ZSL/2 握手、session seal/open 与外层 `frame {v,k,f,n,d}` 属于已冻结的 Link v2 线协议；本节不要求修改这些字节。
- 本节 JSON 展示的是**新业务 body 的逻辑信封**，经 canonical CBOR 编码后放入既有 KIND 的 body，不是另起一个 TCP/HTTP 协议，也不是把外层 Link v2 改为 JSON。
- `contracts/*example.json` 是目标合同的**结构示例与验证基线**。实现每一业务 op 前，必须补该 op 的独立 schema、 `required/limits`、CBOR golden vectors 和兼容性测试，不能只验证通用 envelope 后就声称 AI/Handoff/VFS 已实现。
- Owned `/api/mobile/v1/*` 的 `protocolVersion=1` 及 frozen SyncOperation/SyncChange 在迁移期保持兼容；不得在旧客户端无协商时强塞新信封。需要 Link owned-sync v2 时，通过 capabilities 显式协商并保留 v1 适配。
- 目标 envelope 中 `protocolVersion:2` 指此**业务信封版本**，不与现有 ZSL/2 名称或 mobile v1 的 HTTP 协议版本混为一谈。

以下字段为 v1 新互联协议的目标合同；Owned mobile v1 在迁移期保留其已冻结 schema，并按 **4.2.1 的确定性映射与协商规则**适配，禁止把两种形状同时塞进同一 body：

#### 4.2.1 mobile v1 → v2 业务信封的确定映射

现有 ZSL owned-sync 业务 body 以 `op` 区分操作，与 HTTP mobile v1 使用同一组 DTO：

| 现有 op | 目标 operation | 既有字段的映射 |
|---|---|---|
| `bootstrap` | `sync.bootstrap` | `pageToken/pageSize → body`；`bootstrapId` 响应沿用，不伪造 |
| `changes` | `sync.changes` | `sinceCursor/limit → body` |
| `push` | `sync.push` | 去除 `op` 后，原 `protocolVersion/deviceId/batchId/baseCursor/registryHash/operations → body` |
| `ack` | `sync.ack` | `deviceId/cursor/appliedOpIds → body` |
| `status` | `sync.status` | 空 body；响应保持当前 SyncStatus 语义 |

**确定规则：**

1. v1→v2 适配发生在**进入新业务 dispatcher 前**，不把原 mobile v1 body 复制进 v2 `body` 后再重复携带一份冲突的外层参数字段。转换后 `body` 是业务请求对象，不是整个旧请求 envelope。
2. `requestId` 新生成 UUID；`idempotencyKey` 在 v1 push 中使用 `push:<deviceId>:<batchId>`，并保留 operation 内既有 `opId` 作为操作幂等依据，不能用新 requestId 代替。**bootstrap/changes/status 是普通只读操作，不引入新的副作用幂等语义，按各自调用时点重新读取；ack 沿用原 `cursor/appliedOpIds` 的单调确认语义，不把多个不同 ack 错合并成一个。** v1 没有原始 requestId 可供关联结果查询时，不得伪造跨请求的查询历史。
3. `deviceId` 取 v1 body 的 `deviceId` 或 ZSL session 已认证设备；`bindingGeneration` 取绑定记录，不接受客户端任意声明。若二者不一致返回 `device_proof_invalid`。v1 body 的 `registryHash` 仅表示客户端已见版本，主端当前 `serverRegistryHash` 必须来自 capabilities/绑定会话；`currentRevision` 只能来自 canonical store，禁止从请求 body 的伪“server”字段读取。
4. `capability` 固定映射为 `sync.bootstrap/sync.changes/sync.push/sync.ack/sync.status`。`schemaVersion=1`、`sessionId/sessionEpoch=null`；普通同步不使用会话 epoch。
5. `deadlineAt` 由接收方按当前限流策略生成，v1 无该字段，不得把不可信旧客户端时间戳当截止时间。
6. **响应沿用原业务 schema，不套用 v2 request envelope**：`sync.bootstrap` 返回 BootstrapPage、`sync.changes` 返回 ChangePage、`sync.push` 返回 PushResponse、`sync.ack` 返回 `{ok:true}`、`sync.status` 返回 SyncStatus。错误按既有嵌套 error schema 返回，并附 `requestId`。不要求旧客户端凭空补齐新响应字段。
7. 服务端解包 v2 时先检查 `kind` 与 operation 对应关系，再校验 envelope，再解析 body。`kind=SYNC_OP` 时只能接受上表 `sync.*`；其他 kind 使用其独立 schema。重复 `op/operation` 不一致、body 内外 `deviceId` 不一致、同时存在 v1 顶层 push 字段与 v2 body、未知 op 都返回 `invalid_request`，禁止猜测兼容。
8. **格式识别不能只靠有没有 `operation` 或 `protocolVersion`**：由 capabilities 中 `linkBusinessEnvelopeVersions:[1]` 与绑定 session 协商出的 envelopeVersion 决定。v1 保持 `op` body；v2 使用本节 envelope。客户端未协商 v2 时，服务端不得下发 v2 body。
9. 服务端在同一连接中不得让 v1/v2 写操作并发穿越；按接收顺序/单飞队列保证业务顺序，只有只读请求可在明确幂等语义下并行。迁移期间保留 v1 adapter，直至能力声明的旧版本支持期结束。

#### 4.2.2 目标信封字段

以下字段为 v1 新互联协议的目标合同；Owned mobile v1 在迁移期保留其已冻结 schema，但映射关系必须显式定义：

```json
{
  "protocol": "zephyr-link",
  "protocolVersion": 2,
  "schemaVersion": 1,
  "kind": 15,
  "operation": "ai.command.dispatch",
  "requestId": "req_...",
  "idempotencyKey": "idem_...",
  "deviceId": "dev_...",
  "bindingGeneration": "gen_...",
  "capability": "ai.execute",
  "sessionId": null,
  "sessionEpoch": null,
  "deadlineAt": 0,
  "body": {}
}
```

规则：

- `protocolVersion` 负责帧/握手不兼容变化；`schemaVersion` 负责业务 body 演进；`registryHash` 负责实体与能力集合兼容。
- 同 `requestId + deviceId + bindingGeneration + idempotencyKey` 重放返回原执行回执，不再次执行。
- `deadlineAt` 过期不得开启新副作用；已完成的结果仍可查询。
- 长连接中必须校验 bindingGeneration 和撤销状态，不能只在握手时鉴权一次。
- 每类 body 有 JSON Schema/CBOR 黄金向量、最大尺寸、深度、字符串长度、数组项数和超时上限。
- 未知字段只在明确标为 `opaquePreserve` 的位置原样保留；禁止把任意未验证对象透传到 canonical service。
- 老客户端不认识必需能力时显式 `unsupported_capability`；不得跳过实体/操作后报告成功。

### 4.3 游标不可混用

| 名称 | 用途 | 单调性/仲裁方 |
|---|---|---|
| entity revision | 实体 CAS | 主端 canonical service |
| changeSeq / appliedCursor | 已应用的远端变更位置 | 主端分配，客户端提交后推进 |
| ackedCursor | 主端已确认收到的客户端位置 | ACK 成功后推进 |
| bindingGeneration | 换绑、撤销、数据库隔离 | 绑定生命周期 |
| sessionEpoch | 会话控制权/执行代际 | 主端原子递增，旧代失效 |
| streamSeq | 同一 epoch 中有序输出 | 当前会话生产者 |
| fileOffset | 文件字节级断点续传 | 客户端 checkpoint + 内容校验 |
| mirrorEpoch | 全量清空、restore、强制重建 | 主端或 vault generation |

### 4.4 错误语义

错误必须包含稳定 code、requestId、是否可重试、是否需 rebind/rebootstrap/用户动作。`success=true` 只允许用于所声明操作已完成，不表示“已收到”“已触发”“其他 pending 也已同步”。

以下状态不得静默吞掉：

- envelope 缺失、AAD/owner 不符、密钥库失败；
- schema/registry 不兼容；
- canonical ledger 缺失或不一致；
- 应用第 N 项失败、staging 未完成；
- Agent 本机拒绝、系统权限丢失；
- 主端重启导致 session 不可恢复；
- 主端/Agent 任一侧的授权收窄。

---

## 5. Owned Sync 数据一致性规范

### 5.1 本地同步状态

三端必须具有等价语义，而非只具同名类：

```text
server_mirror             完整 canonical JSON + opaque/unknown 字段
optimistic_overlay        本地未上传编辑，独立于 server mirror
pending_operations        稳定 opId 的 outbox，含 upsert/delete/restore
secret_journal            SecretStore 与 DB 崩溃恢复日志
bootstrap_staging         分页快照隔离区
bootstrap_progress        可续传检查点
conflicts                 base/local/server 与解决结果
applied_cursor            本地已原子应用的游标
acked_cursor              主端已确认的游标
binding_generation        换绑/撤销/清库边界
mirror_epoch              全量重建边界
```

### 5.2 同步轮次

```text
验证绑定、能力、registry 与密钥可用性
→ bootstrap 或恢复既有 checkpoint
→ 按依赖顺序及批次上限 push pending
→ pull + 保护本地 pending 的 merge
→ 原子提交 mirror/secret/FTS/overlay/conflict
→ ACK
→ 处理 deferred/conflict/不兼容状态
→ 仅在真实收敛后显示“已同步”
```

`serverCursor` 不得直接赋给 `appliedCursor`。ACK 失败、应用失败、密钥失败、进程崩溃均不得越游标。

### 5.3 本地写入与 outbox

- 业务镜像与 pending op 必须在同一个本地事务提交。
- 新行 `baseRevision=0`；更新取最后确认的 serverRevision，禁止读取展示模型的本地 revision 代替。
- op 保存 action、baseRevision、真实 fieldMask、secret mutation、createdLocally、dispatchedAt、attemptCount。
- 网络结果未知时按原 opId 重试，服务端幂等回执负责去重。
- accepted/duplicate 才可完成 op；仍须按协议 ACK 后清理相关密钥 journal。
- 删除/恢复与更新同队列；按依赖顺序和服务端批次上限分批。
- 下行遇到 pending 不得覆盖 optimistic overlay；需三方比较并保留冲突。

### 5.4 bootstrap 与迁移

- bootstrap 页写入 staging，不直接污染可见业务镜像。
- 主端提供 MVCC 快照或不可变 staging；不能只记录实体最大 ID 后在后续页读取实时列表。
- 页中 secret presence/envelope 必须全部校验通过才提交；已知类型 projection 失败须 abort/rebootstrap，不能标 unsupported 后跳过。
- 完成全部页后才原子 promote；旧镜像保留到切换前。
- 升级前备份；历史 entity/field ledger 必须回填。无法证明字段历史时强制 rebase/bootstrap 或保留冲突，不能把空账本当无冲突。

### 5.5 冲突合同

- 不同字段可自动合并；同字段默认保留冲突，不采用客户端墙钟自动覆盖。
- 冲突保存 `base/baseRevision/local/server/mergedPayload`，解决时生成新 opId 与正确的新 baseRevision。
- `COPY_AS_NEW` 必须使用全新 UUID，禁止固定 `id-copy`。
- 笔记 diff3 仅在 base/local/server 可证明时自动合并；有未解决 hunk 时必须人工选择。
- 删除优先规则下，本地 pending 编辑必须转冲突副本，不得静默删除。
- `MobileV1Store.hasOverlap` 与完整路径必须使用相同父子路径语义，覆盖 `config` 与 `config.x`、数组根/叶子。

### 5.6 activityEvent

活动审计使用 append-only ingest，而不是普通可编辑 upsert：

```text
eventId / eventType / occurredAt / receivedAt / sourceDeviceId
sourceDeviceAlias / protocol / connectionId / outcome / durationMs
schemaVersion / privacy-safe metadata
```

本地 ActivityJournal 离线持久化，主端 `(ownerUserId,eventId)` 去重后生成 changeSeq 并广播。SSH/Telnet/RDP/VNC 会话开始、失败、断开，SFTP 上传/下载/删除/修改，批量命令与 AI 工具调用必须统一埋点。命令原文、密码、私钥、完整 AI prompt 默认不得进入活动同步。

活动清空采用 mirrorEpoch 或明确的“只清当前视图”，不能对 append-only 历史做无日志全表 DELETE 后让各端猜测。

---

## 6. WebDAV Vault v2

### 6.1 分阶段目标

1. **先**：独立密码 E2EE 备份、校验、完整恢复、代际保留。
2. **后**：多设备 OpLog、冲突与断点恢复、密钥轮换。

绑定主端时 Vault 是独立灾备；不得让主端与 Vault 自动互写形成双主循环。

### 6.2 远端结构

```text
/ZephyrOneSync/<vaultId>/
  manifest.cbor.zenc
  devices/<deviceId>.cbor.zenc
  snapshots/<snapshotId>.cbor.zenc
  oplog/<deviceId>/<seq>.cbor.zenc
  generations/<n>/...
```

- 使用随机 256-bit vault master key；独立密码经 Argon2id 派生 KEK 后包裹，不能直接用密码逐 op 加密。
- AAD 绑定 vault/device/entity/epoch/schemaVersion；认证失败整包拒绝。
- 具备强 ETag 的 manifest 使用 ETag/If-Match CAS。**“换用整代快照”不能替代服务器端条件写**：在不支持强 ETag、If-Match、If-None-Match 或不可依赖的原子 MOVE/PUT 的 WebDAV 服务上，客户端之间不存在可靠的共享 manifest 互斥，禁止启用多写者 OpLog 或宣称可安全多写同步。
- 提供端能力探测及分级：
  - **B0（离线导出）**：可 PUT/GET 独立 vault，仅用于下载/手工导出；不可宣称自动备份。
  - **B1（单写者备份）**：有原子 publish、稳定身份和读回校验，但缺强条件写/一致枚举时，仅允许一个持久 writerId；不提供多设备自动合并。更换写者必须人工“独占接管”，其他设备只读。
  - **B2（多写者同步）**：同时具备强 ETag、条件写/原子 publish、列出后读回一致性确认及并发负例，才能开放 per-device OpLog 和共享 manifest 更新。
- 弱 ETag 不能作为互斥证明；无 ETag/不支持条件写时只能 B0/B1。`MOVE Overwrite:F`、临时随机对象名、读回字节校验可减少误覆盖，但**不能证明跨 writer 的 read-modify-write 原子性**。
- 服务端/实现若选择单写者加 lease 作为优化，必须接受 lease 过期后的时钟偏差与裂脑风险；lease 绝不能把 B1 伪装成 B2。需要真正多写者时，只能选 B2 存储或引入一个具有事务能力的协调者，不能靠客户端锁文件幻想 CAS。
- manifest 的 `writerEpoch` 由 B2 条件写更新；同 epoch 多写者写不同 device oplog，可重读重放合并，再提交新 head。失败保留各设备原始 op，禁止删除未确认数据。
- 若威胁模型包含恶意存储，需要设备签名 op/head、单调 generation 与带外设备验证，检测删除 op 和整库回滚。
- 统一 registry、op、tombstone、冲突与 activity append 规则。
- 支持首次导出、他端导入、离线完整恢复、损坏包隔离、代际保留和密钥轮换。

### 6.3 明确安全边界

密钥轮换只能重加密受控副本并切断未来在线授权，**不能让攻击者已下载的密码、私钥或旧密文作废**。真正泄露时还需轮换目标服务器凭据。

现有主端 WebDAV v1 单文件加密备份仅作兼容导入，不得直接改名为多端同步。其 AES-GCM、SSRF 防护、条件 MOVE、ETag 检测与限额实现可以复用。

---

## 7. ZSL-HANDOFF/1 跨端接力

### 7.1 执行拓扑

- 可接力会话必须由主端发起并锚定真实上游连接。
- One 的 `initiateViaPrimary=true` 时，通过 Link 请求主端建立会话；`false` 时本机直连，不承诺跨端无缝接力。
- 主端锚定 PTY/RDP/VNC 时属于 `trusted-primary`；不得宣称主端不可见内容。
- 主端只保留恢复所需最小状态；快照、屏幕、输入均受会话 ACL 和撤销状态约束。

### 7.2 控制权切换

1. 目标设备发起带 requestId 的 `HANDOFF_REQUEST`。
2. 同账号有效自有设备按默认 `instant`；跨用户或高风险按审批策略。
3. 主端原子执行 `sessionEpoch++`，绑定新 ownerDeviceId。
4. 原设备收到 `HANDOFF_TRANSFERRED`，回到 Smartbar；新设备收到 `HANDOFF_COMMIT` 和快照。
5. 旧 epoch 输入、批准、工具调用、relay attach 一律拒绝。

### 7.3 快照与流恢复

- SSH/Telnet 使用可验证的 headless terminal + serializer，保证 scrollback、alternate screen、颜色、光标、尺寸与 seq 对齐。
- RDP/VNC 接管前发送全屏关键帧或等效基准帧，不能只靠静态图片掩盖状态丢失。
- 终端恢复必须等待真实 VT 状态应用完成，而非仅等待动画；`term.resize`、snapshot restore、增量输出必须按顺序。
- 恢复后仅接收新 epoch 且 seq 连续的实时数据，缺口触发重新快照而非静默跳帧。
- 主端重启第一阶段允许明确“会话不可恢复并重建”，不能把内存会话宣称 HA。

---

## 8. Agent 独立授权与跨端文件/VFS

### 8.1 每台 Agent 独立配置

用户必须能在 Agent 所在设备独立配置并立即生效：

| 配置域 | 必须可配置项 |
|---|---|
| 身份与共享 | 显示名、绑定主端、允许哪些账号/调用者、在线时间 |
| 目录/VFS | 每个本地目录、SMB/SFTP/WebDAV share 的路径、只读/读写、是否显示 |
| 文件操作 | list/stat/read/write/mkdir/delete/rename/truncate 分项；删除另需确认 |
| 剪贴板 | 文本发送/接收、文件 manifest、文件内容拉取、允许的方向 |
| 网络/隧道 | 是否允许 -L/-R/-D、目标网段/端口、监听地址、端口范围、默认回环 |
| RDP/远程 | 盘符映射、剪贴板注入、键鼠控制、共享桌面 |
| AI/Cell | AI 可读取的 share、可写目录、可执行工具、Offload 子能力 |
| 资源配额 | 文件大小、chunk、并发、窗口、磁盘、速率、每日流量、目录深度 |
| 审计与撤销 | 本机审计、最近调用、单项撤销、全部暂停、解绑与授权清除 |

授权 UI 必须显示**实际生效结果**：`Agent 本机允许 ∩ 主端 ACL ∩ 系统授权 ∩ 当前会话`。不得只展示主端“已授权”，却在 Agent 本机策略已禁用时给出误导性成功状态。

### 8.2 本机策略模型与确定求值顺序

策略示例只展示结构，实际执行必须按下面的顺序求值；不能由不同工程师分别理解成“第一条 allow 即通过”“最后一条覆盖”或“主端再判一次即可”：

1. **协议与策略校验**：schema、subject/channel/operation/share/target 格式、数值上限必须合法；未知操作默认 deny，不可默默忽略无效规则。
2. **暂停/撤销/绑定状态**：`paused=true`、设备已解绑/撤销、Agent 离线且该操作要求在线、调用者或资源已撤销时直接 deny。
3. **策略代际**：session/lease/ticket 的 `policyGeneration` 必须等于本机当前 generation；不等则 `agent_policy_generation_stale`，不得继续用旧规则求 allow。
4. **收集匹配规则**：subject 必须包含调用者；channel、operation 匹配；share、目标网络、监听地址、Offload 子能力与过期时间匹配。未指定资源维度的规则不能自动获得该维度的任意权限：`shares=[]` 表示无目录权限，`networkTargets=[]` 表示无网络目标，`offloadCapabilities=[]` 表示无 Offload 权限。
5. **deny 优先**：任一匹配且有效的 `effect=deny` 规则直接拒绝，不能被另一条 allow 覆盖。 deny 规则必须带审计原因，不因 generic allow 而失效。
6. **allow 判定**：至少一条匹配且有效的 allow 才能继续；没有任何匹配 allow 时按 `defaultEffect=deny` 拒绝。allow 不给超出本规则 shares/targets/operations 的额外权限。
7. **限制求交集**：对所有匹配 allow 的 `maxFileBytes/maxInflight/maxChunkBytes/maxDailyBytes/maxDirectoryDepth/maxRequestsPerMinute` 取**最小正值**；任一显式为 0 表示禁止该维度对应操作。不同字段不能互相补全为无限。
8. **主端 ACL 与系统授权取交集**：主端 ACL 必须允许相同 channel/operation/share/target；系统目录、网络与通知等授权也必须有效。任一失败拒绝，主端不能覆盖。
9. **高风险独立审批**：删除、revealSecret、非回环监听、远程 wipe、共享写入、高危 AI 工具调用，除普通 allow 外还需当前 `confirmationId`，且该确认绑定 `requestHash/policyGeneration/resource/operation/expiresAt`；缺失、过期或 hash 不符返回 `approval_required`，不可使用“以前同意过”。
10. **原子复核与执行**：真正打开文件、监听 socket、调用工具前再次读取本机 generation 和系统授权；若已变化，拒绝。对写操作以 `agentId+requestId/idempotencyKey` 持久化回执，重试只返回原回执。
11. **配额原子扣减**：并发计数、日流量、请求速率按本机事务或等效原子机制扣减；超限返回 `agent_quota_exceeded`，不得先执行后补扣。

**多条规则语义总结：** `deny > allow > quota 最小值 > 主端 ACL ∩ 系统授权 > 独立审批 > 执行前复核`。没有默认“更具体规则优先”这种隐含覆盖，避免通过 broad deny 加一条 narrow allow 绕过；若未来引入 priority，必须另增版本化规则与完整测试，不在 v1 隐式添加。

本机策略模型：

```json
{
  "schemaVersion": 1,
  "agentId": "agent-local-id",
  "policyGeneration": 17,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "rule_...",
      "subjects": ["user:alice"],
      "channels": ["file-bridge"],
      "operations": ["list", "stat", "read"],
      "shares": ["projects-readonly"],
      "networkTargets": [],
      "listenHosts": ["127.0.0.1"],
      "effect": "allow",
      "limits": {
        "maxFileBytes": 268435456,
        "maxInflight": 4,
        "maxChunkBytes": 262144,
        "maxDailyBytes": 5368709120
      }
    }
  ]
}
```

要求：

- 默认 deny；新增能力不能因应用升级自动变成 allow。
- `policyGeneration` 单调递增；旧策略生成的 lease/ticket/stream 必须失效。
- 本机敏感变更可要求系统锁/生物识别；无需依赖主端在线。
- Agent 本机可一键暂停所有跨端能力或单项撤销。
- 主端缓存的能力必须带 generation；执行前 Agent 再验，不以主端缓存替代最终裁决。
- 主端离线时不得通过旁路放宽本机策略；明确需要离线的已授权本机共享才可按本机规则工作。
- 规则导入/导出经用户确认，签名或明确标记不可信来源，禁止自动赋予高危权限。

### 8.3 文件与 VFS 安全

- 统一 `/<deviceId>/<shareId>/<relativePath>` 虚拟路径；share 不能任意写 `..`、绝对路径、symlink escape 或 NTFS/Unix 特殊别名。
- 默认只读、默认回环、默认最小目录；写入、删除、SMB 写、端口转发逐项授权。
- 文件内容只在请求时拉取，ClipboardManifest 不预传全部内容。
- 64–256KB 分块、有限窗口、offset checkpoint、取消与 SHA-256 完成校验。
- 后端必须真实实现再声明 SMB/SFTP/WebDAV；不能用目录 UI 或 Go import 名称冒充协议兼容。
- `zephyr-agentd` 与 GUI Agent 复用同一 Go VFS 和授权核心，无 UI 时同样提供本机安全配置导入与审计。

### 8.4 端口转发

- Web 远程部署时，本地端口落点必须是用户电脑上的 Agent，不能是远端主端回环地址。
- One 直连由本机 `libzephyr` 处理；协同模式由本机 InitiatorHub + 主端 relay 处理。
- -L/-D 默认 `127.0.0.1`；-R 默认远端回环或用户明确批准的地址。
- `0.0.0.0`、局域网/公网监听必须显式审批，并展示真实暴露面。
- Agent 按独立策略限制目标地址、端口和网段，主端不得绕过。
- 断线、会话结束、授权收窄、撤销或解绑必须清理 listener、forwardIn、关联连接与 lease。

---

## 9. AI RPC / Cell 协同

### 9.1 通道与执行位置

- `KIND.AI=15` 只表示 AI lane；现有 echo/ack 处理器不代表 ZSL-AI-RPC/1 已完成。
- 明确 `executionTarget: local | primary_cell | remote_host`，UI 显示实际执行位置与数据出域。
- AI 可使用的主端凭据、目标资源、工具集合和输出必须逐次授权，不得因连接存在而全量开放。

### 9.2 标准消息

- `ai.command.dispatch`：requestId、conversationId、prompt、目标、执行位置、权限模式、设备证明。
- `ai.stream.event`：conversationId、runId、seq、eventType、delta、metadata。
- `ai.cell.pty.frame`：cellId、sessionEpoch、seq、尺寸、PTY bytes。
- `ai.approval.request/decision`：approvalId、runId、工具、完整命令预览、风险、目标、TTL、设备签名。
- `ai.command.result`：requestId、终态、输出引用、错误、执行位置和可重放结果。

重复 dispatch 不得重复执行；超时后必须通过 requestId 查询原 run，而不是直接再下发。审批必须绑定当前 run/tool/inputHash；输入改变后旧审批无效。

### 9.3 安全

- 高危命令、凭据 reveal、非回环监听、共享写入、远程 wipe 必须显式审批。
- SecretVault 只替换/还原获授权的 secretRef，禁止把原文写入 prompt、日志、AI history 或同步活动。
- 远端日志/网页/工具输出作为不可信输入处理，不能仅凭标签声称完全阻止提示词注入；工具权限按内容风险进一步收窄。
- Cell 工具按平台能力实际提供，不能用 6 命令白名单、接口或 mock 冒充完整 Linux/Go Cell。
- Link/AI/Cell 在 Android/iOS 合并为唯一 Go runtime，ABI 错误、进程退出与版本不兼容必须有可诊断降级。

---

## 10. Shared-to-me 在线使用

- 共享目录只存内存；严格禁止进入 owned 同步、FTS、最近记录、草稿、通知、崩溃转储及系统备份。
- 目录响应只含展示元数据，统一 `no-store/private/no-cache` 与禁键/白名单防火墙。
- 建立会话时复核 Owner、Sharee ACL、资源 revision、依赖 ACL、设备 generation。
- 主端解析真实凭据建立上游连接；Sharee 只拿一次性、短时、设备绑定的 relay credential。
- relay attach 单次消费；重放、跨设备、过期或旧 generation 必须拒绝。
- 撤销同时关闭 HTTP/SSE/ZSL/shared relay 与文件 lease；不能只在下一次 HTTP 请求时检查。
- `assertNoForbiddenKeys` 必须由统一序列化出口调用，覆盖 refresh/lease/错误与嵌套对象，不只 detail/note-read。

---

## 11. 撤销、擦除、密钥轮换与高可用

### 11.1 撤销

- 撤销立即更新设备 generation/CRL，并主动终止 HTTP、SSE、ZSL、shared、relay、tunnel、文件 lease 和待执行 AI。
- 已过期/旧 epoch 输入、票据、pending command 均失效。
- Agent 本机独立撤销立即生效，不以主端可达为前提。

### 11.2 wipe

- wipe 是独立于普通 revoke 的强指令，需二次确认与审计。
- 只清 Linked 数据域、设备私钥、绑定凭据和相关 secret scope，绝不清 Local。
- 离线设备只能下次联网执行；不得宣称即时物理自毁。设备须回报清除进度、失败和可重试 journal。

### 11.3 高可用

第一阶段明确“单主/sticky + 可恢复重连”。跨进程/多副本 wake 使用 DB lease/fencing 或外部队列，不能使用进程内 `activeLeader` 作为全局锁。

若未来启用在线迁移，必须有：

- durable session state / ticket consumption / ACL revision；
- 单调 sessionEpoch + fencing token；
- 输出 checkpoint 和重复输入去重；
- 主端故障切换时不双写、不重复执行 AI/端口/文件操作。

---

## 12. Go 与二进制供应链安全

1. Go 构建工具链统一为 **1.26.10**，Docker 固定对应版本（可附加 digest）；禁止用浮动版本掩盖真实产物。
2. `golang.org/x/crypto` 至少 **v0.56.0**；所有 Go module 执行 `govulncheck`，不能只看 go.mod 的 `go 1.23/1.24`。
3. 重编译 Link server/embed/Android、AI runtime/JNI、Worker、Agent、Cell、RDP/WASM 等所有真实产物。
4. 每个原生产物执行 `go version -m`，断言 toolchain 与源码 revision；再执行 `govulncheck -mode=binary`。
5. 发现仓库提交的旧 `.so` 时不得因为 workflow 已改版本号而豁免，必须重建并重新发布。
6. 覆盖撤销证书链负例、SPKI pin 正例、ZSL 互操作、HTTP/2 压测、平台签名与启动冒烟。
7. `x/net/html` 等漏洞必须按真实依赖与调用图评估；不得为了“预防”引入未使用依赖。
8. 安全修复独立于大型同步/互联重构，保证可回滚和快速发布。

---

## 13. 实施阶段与依赖

| 阶段 | 内容 | 不得提前宣称的结果 |
|---|---|---|
| P0 | Go 安全热修；桌面 CAS/cursor/坏 envelope/账号隔离止血 | 未重发二进制、未过回归不得称安全/可靠 |
| P1 | Desktop outbox/staging/conflict/secret journal；主端 bootstrap/ledger/GC；统一 wake | 五类正确闭环后才扩实体 |
| P2 | 实体矩阵、activity append、冲突 UI、Local→Linked 导入 | 不允许仅 registry 增加就宣称全量同步 |
| P3 | iOS/Android 生产接线、ZSL transport、三端两两互测 | mock 不得替代真实 App 与主端联测 |
| P4 | WebDAV v2 备份恢复 → 多写 OpLog；撤销与 key epoch | 先恢复证明，再多写同步 |
| P5 | Link 版本化合同、Agent 独立策略、VFS/端口转发 | 不得绕过 Agent 本机策略 |
| P6 | Handoff、AI RPC、Cell、高可用增强 | 不以动画/UI/echo ack 代替协议和真实执行 |

---

## 14. 测试与发布总则

**详细、强制的测试矩阵见 [TESTING-AND-RELEASE-GATES.md](./TESTING-AND-RELEASE-GATES.md)。以下规则不可降级：**

1. 每个 Link 改动必须先列出受影响 channel、平台、数据域、身份状态、协议兼容与故障场景。
2. 静态源码检查、mock 单测、真实 Go/Node 互操作、真实主端、原生编译、模拟器/真机验收是不同证据层，禁止互相替代。
3. 本次已发现的 cursor/CAS/离线覆盖/删除/坏 envelope/串库/旧 Go 二进制问题必须固化为永久回归用例。
4. 必测平台未编译、未运行、失败、报告缺失或环境无法证明时，均为**未通过**，不能用其他平台绿灯抵消。
5. 任一 Link 通道扩字段，必须验证“不影响其他通道”；共享 ZSL 会话上不得因单个 lane 的错误处理污染 owned sync、AI 或文件流。
6. 新互联功能至少包含正常路径、权限拒绝、并发、重试、断线、崩溃恢复、撤销、版本兼容和资源上限测试。
7. 未满足发布门禁时，只能标注“未验证/实验”，不得发布为稳定功能。

---

## 15. 验收与完成定义

一个互联能力只有同时满足以下条件才可标为完成：

- 对应协议 schema、错误码、权限、限额和兼容向量已冻结；
- Agent 本机授权与主端 ACL 取交集的真实拒绝/允许路径已验证；
- 目标平台的真实实现、真实依赖与真实网络路径已跑通；
- 离线/并发/断网/崩溃/撤销/升级/版本兼容测试通过；
- 安全扫描、原生二进制检查和资源限制通过；
- 失败可见、可诊断、可恢复，不静默丢数据、不静默降权或提权；
- 交付报告明确列出实际执行的平台、版本、设备、测试数量、原始日志与未覆盖项。

**禁止以“21 类已注册”“16 个 KIND 已定义”“UI 已画”“单端 mock 全绿”“别的分支以前绿过”代替上述完成定义。**

---

## 16. 文档变更纪律

- 本规范及 Agent 策略 schema、帧 envelope、错误码的任何修改必须记录变更原因、兼容影响和新增测试。
- 修改本规范不得悄然降低 D15：Agent 本机用户的最终授权裁决不可被主端或调用者覆盖。
- 决策若需调整，必须追加 ADR，保留旧版本与迁移路径，不得直接改写历史已发布协议的含义。
- 未实现的章节保留为实施目标，发布说明只能引用已验证的条目。

[RULES I BROKE]：无。
