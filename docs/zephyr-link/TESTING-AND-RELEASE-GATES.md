# Zephyr Link 测试矩阵、故障注入与发布门禁

| 项目 | 内容 |
|---|---|
| 文档编号 | ZEPHYR-LINK-TEST-001 |
| 文档版本 | 1.0.0 |
| 状态 | Mandatory / 强制执行 |
| 适用规范 | `ZEPHYR-LINK-INTERCONNECTION-SPEC.md` v1.0.0 |
| 原则 | 用真实故障证明可靠性，不用绿灯截图掩盖未测路径 |

> 目的：防止不同工程师在多端迭代中，因一个“很小”的协议、游标、权限、状态或构建改动，让同步和跨端互联在用户环境中静默失效。**任何必测层未跑、失败、报告缺失或环境不成立，都不是通过。**

---

## 0. 反绕过、反假通过与生产一致性强制规则

1. **样例数量不是质量证明**：不得用“8 条/几十条参考用例通过”代替完整兼容性与故障覆盖，更不得把参考模型通过宣称为生产通过。
2. 所有同步映射、Agent 策略与 WebDAV 写者分级的规范向量统一位于 `docs/zephyr-link/conformance/cases/`，Node/Go/Kotlin/Swift 的生产适配器必须消费**同一文件、同一预期**，禁止各端私自翻译、删减或放宽。
3. **参考适配器与生产实现严格分离**：`reference-adapter-v1.mjs` 只验证规范示例，输出 `documentation-reference`。真实生产证据必须来自实际生产函数及适配器，满足 [PRODUCTION-ADAPTER-CONTRACT.md](./conformance/PRODUCTION-ADAPTER-CONTRACT.md)。
4. 每个生产待验向量必须有真实执行结果。`productionRequired / unsupported / skip / todo / not_run` **一律不是 pass**，不得通过修改状态或删除案例将其转为通过。
5. 高敏合同、向量、预期与生产测试若被同一 PR 修改，必须提供修改前后双跑证据；需要失败的案例必须先在旧版本失败，再在当前版本得到合同结果。
6. **真实源码 mutation 必跑**：故意移除设备校验、KIND 校验、deny、空资源限制、零配额、审批、CAS、协议协商等，必须被见证用例全部杀死。陈旧、未适用或未执行的 mutant 均不得计入 killed。
7. 不能只测返回值：涉及副作用的向量必须检查实际实体、cursor、revision、outbox、secret、lease、listener、审计、幂等回执和文件字节。
8. **参考绿灯不解除发布门禁**：如果生产适配器未提供、未覆盖目标平台、报告缺失、失败、有生产待验项或 mutant 存活，仍不得发布稳定功能。
9. 高敏合同与生产适配器须独立复核，防止实现者同时修改坏实现与测试预期“协商出”假通过；不能以一次历史 reviewer 通过永久豁免后续变更。

### 0.1 当前反绕过基线（必须持续增加，不允许删减规避）

| 类别 | 当前规范向量数 | 当前参考执行数 | 当前生产待验数 | 当前真实源码变异 |
|---|---:|---:|---:|---:|
| mobile v1 / 新同步信封 | 64 | 部分格式/身份/映射反例 | 其余 entity、secret、cursor、auth、schema、真实响应 | 身份/KIND/双重 envelope/协商 |
| Agent 本机策略 | 109 | 109（含 Schema/规则/审批/重试） | 生产 Agent 与系统权限联调另计 | deny/空资源/配额/审批/撤销后重放 |
| WebDAV 写者与故障 | 72 | 能力分级与 CAS 反例 | 真实 WebDAV 状态/故障/恢复全部待验 | 多写者/弱 CAS/无条件覆盖 |
| **合计** | **245** | **159** | **86** | **20/20 killed** |

这组数字是当前基线，**不是“245 项产品测试全部通过”**。若后续实现增加新操作、字段、存储后端或故障模式，必须同时补充向量、生产适配器与真实见证，不得仅更新参考函数或数字。

---

## 1. 强制测试分层：不同证据不可互相冒充

| 层级 | 必须回答的问题 | 合法证据 | 不能替代成 |
|---|---|---|---|
| L0 静态/生成物 | schema、注册表、导出符号、依赖是否漂移 | codegen diff、静态符号检查、schema lint、SBOM | 实际同步/网络/权限闭环 |
| L1 纯逻辑单测 | 算法、状态机、字段掩码、冲突规则是否正确 | Node/Go/Kotlin/Swift 单元测试、边界向量 | 真实主端、数据库、系统密钥库 |
| L2 存储与事务 | 本地事务、回滚、迁移、journal、游标是否一致 | 真 SQLite/Room/SQLCipher、崩溃与恢复测试 | 内存 fake 永远成功 |
| L3 跨语言协议互操作 | Go/Node/Kotlin/Swift 是否字节一致、错误一致 | 黄金向量、真实 Go 进程、跨语言握手/帧测试 | 只测同一种语言序列化 |
| L4 真实主端集成 | canonical service、change feed、权限、ledger、撤销是否正确 | 启动真实 `server.js` + SQLite + Go Link server | mock adapter / Express stub 当生产 |
| L5 客户端运行时 | 实际 DI/Repository/UI/密钥库/网络是否接线 | Electron/Tauri、真实 App 宿主、系统 Keystore/Keychain | 只实例化未使用类或 fake store |
| L6 多设备端到端 | 多端读写、冲突、重连、共享和 Agent 是否真实收敛 | 两个以上客户端 + 真实主端 + 真实 Agent | 同一进程 mock 两端 |
| L7 原生发布产物 | 真实安装包内二进制、权限、签名和启动是否正确 | APK/IPA/安装包/容器镜像/原生 `.so` 检查与冒烟 | CI 文本写版本号、源码库测试 |
| L8 故障与长稳 | 弱网、崩溃、慢设备、背压、长会话、重复操作是否可靠 | fault injection、kill/restart、网络 shaping、 soak report | 仅正常网络短时演示 |

**L0–L4 通过不能外推 L5–L8 已通过。测试名或源码正则断言只能算 L0/L1，不能宣称产品可用。**

---

## 2. 每次 Link 改动的“影响声明”

PR 必须填写以下字段，不允许只写“修复小 bug”“优化同步”：

```yaml
change:
  channels: [owned-sync, file-bridge, ai, ...]
  platforms: [server, desktop, android, ios, agent, agentd, webdav]
  dataDomains: [local, owned, shared-to-me]
  states: [unbound, bound, offline, conflicted, revoked, migrating]
  protocolImpact: [none, additive, breaking, registry-only]
  dataImpact: [cursor, revision, tombstone, secrets, schema, binary, none]
  requiredEvidence: [L0, L1, L2, L3, L4, L5, L6, L7, L8]
  failureInjections: [timeout, duplicate, kill, offline, revoke, ...]
  compatibility: [old-server, old-client, new-server, new-client]
  rollback: [database backup, previous binary, protocol fallback]
  evidenceLinks: [CI run, artifacts, device logs, raw metrics]
```

### 2.1 必跑集合如何确定（避免两种误读）

- **不是每个拼写/注释改动都要真机全量回归**：L0 确认无行为影响且代码/生成物 diff 为空的纯文档改动，可只跑文档与合同检查。
- **也不是只改一个函数就只需该函数单测**：一旦行为受影响，必须执行对应通道的**最小阻断集**、受影响的现有全部相关回归，以及第 2.2 表中的更高证据层。
- 任何同步/互联代码改动最低为 `L0 + L1 + 相关 L2/L3/L4`；若影响实际平台业务接线，必须追加 `L5/L6`；若影响发布二进制或用户可见数据正确性，追加 `L7`；涉及重试、并发、断线、崩溃、弱网、撤销或流控时追加 `L8`。
- 触碰共享 ZSL session、公共 codec、身份、密钥、canonical 写入、Agent 最终裁决的改动，必须额外验证所有共享受害通道，不能只测业务调用者。
- **发布门禁与 PR 门禁不同**：PR 按影响声明测试；候选发布还必须验证所有目标发布产物和声明支持的平台，不允许只凭一个 PR 的局部覆盖发稳定版。
- 出现 flaky、环境崩溃、超时、无法获取 artifact 时，先标为未验证并修复测试环境；禁止简单 retry 到偶然通过后丢弃失败日志。

### 2.2 变更范围映射

| 改动内容 | 最低强制验证 |
|---|---|
| KIND/channel/envelope/codec | L0/L1/L3/L4；全部共用一个 Link session 的通道隔离；非法帧、大小、压缩、错误处理 |
| entity/field/registry | L0/L1/L2/L4/L5/L6；受影响实体的三端读写、opaque/unknown、迁移、共享边界 |
| CAS/cursor/ACK/retry | L1/L2/L3/L4/L6/L8；重复响应、漏响应、乱序、kill、跨设备高 cursor |
| Secret/KDF/keyStore | L1/L2/L3/L5/L6/L7/L8；错误 AAD、锁屏、密钥轮换、崩溃恢复、真实平台密钥库 |
| Agent policy/share/VFS | L1/L4/L5/L6/L7/L8；本机与主端权限交集、路径逃逸、系统授权撤销、断线回收 |
| Handoff/AI/隧道/流 | L1/L3/L4/L5/L6/L8；epoch/seq、旧输入、幂等、背压、重启、真实上游会话 |
| UI 同步状态/冲突中心 | L1/L5/L6；真实 pending/conflict/error，不能仅显示成功或数量 |
| Go 版本/依赖/构建脚本 | L0/L1/L3/L7；所有实际发布二进制版本、漏洞、签名、启动和互操作 |
| CI 测试本身 | 证明测试会失败；先运行回归变体，再验证修复后通过；禁止无断言/假通过 |

---

## 3. 每个 bug 的强制回归流程

1. **先复现**：记录版本、初始身份、数据、网络、并发和触发顺序，保留最小输入。
2. **先证明旧代码失败**：回归测试必须在未修版本失败；无法复现的旧 bug 不可标“已修复”。
3. **写用户结果断言**：断言真实实体、密钥状态、cursor、outbox、权限和最终各端状态，不只断言“无异常”。
4. **加入故障变体**：至少覆盖断网、重复、kill/restart、权限收窄中的相关场景。
5. **修后跨层验证**：按影响声明跑 L0–L8，不只跑新增测试。
6. **检查相邻通道**：共享同一 ZSL session/数据库/密钥库的其他通道不得被污染。
7. **真实产物复验**：验证最终安装包，不只验证工作区源码。
8. **保留证据**：原始日志、输入、环境、commit、平台、设备与未覆盖项。

### 3.1 禁止“修复测试”作弊

- 不得删除原失败断言、缩短输入直到通过、把错误改判为合法、用 mock 取代被测对象。
- 不得只检查函数/字符串/类存在，不检查实际行为。
- 不得把 skipped/todo/not-run 当 pass。
- 不得使用别的分支/旧提交/其他模型的历史绿灯证明当前 SHA。
- 不得把构建成功、安装成功或 UI 可打开当成同步正确。

---

## 4. Owned Sync 永久回归目录

以下场景属于每次触及同步代码时的必测集，不得因“改动很小”删除。

### 4.1 CAS、revision 与本地 outbox

| 编号 | 场景 | 必须通过的用户结果 |
|---|---|---|
| SYNC-CAS-001 | 本地新建行 revision=1，远端不存在 | 以 baseRevision=0 创建，不发生 revision_conflict |
| SYNC-CAS-002 | 主端 revision=41，本地 revision=10 后编辑 | 使用主端确认的基线，不错误漂移成本地 +1 |
| SYNC-CAS-003 | 同实体连续编辑、进程重启 | outbox 保留正确基线和合并语义，不重复、不丢失 |
| SYNC-OUT-001 | 上传成功但响应丢失 | 同 opId 重放，主端幂等，无重复行/重复副作用 |
| SYNC-OUT-002 | accepted/duplicate/rejected/conflict 混合批次 | 各自按协议处理，不把 rejected 当成功 |
| SYNC-OUT-003 | 201+ ops、依赖资源顺序 | 正确分批、依赖在前，无整批超限或死循环 |
| SYNC-OUT-004 | 本地删除、恢复、硬删 | delete/restore 真实上传，删除后不复活 |
| SYNC-OUT-005 | kill 于业务写入与 op 入队之间 | 重启后镜像与 outbox 一致，无“可见编辑无 op” |

### 4.2 cursor、分页与 ACK

| 编号 | 场景 | 必须通过的用户结果 |
|---|---|---|
| SYNC-CUR-001 | 本地 applied=10，push 返回 serverCursor=20 | 仍从 10 拉取并应用 11–20，不跳变更 |
| SYNC-CUR-002 | 页面第 N 项失败/进程 kill | 已提交页正确，未提交页重拉；cursor 不越过 |
| SYNC-CUR-003 | ACK 失败/超时/重复 ACK | applied/acked 分离，恢复后不重复副作用 |
| SYNC-CUR-004 | bootstrap 100+页中断、token 过期 | 旧镜像完整，staging 可恢复或整代重建 |
| SYNC-CUR-005 | 分页间新增/修改/硬删且 bridge 漏写 | 一致性校验失败并 rebootstrap，不静默漏行 |
| SYNC-CUR-006 | 已知类型 canonical projection 失败 | 不得 `unsupported=true` 跳过并推进 |
| SYNC-CUR-007 | cursor 超过主端、retention 已裁剪 | 明确 cursor_expired/rebootstrap，不静默从零覆盖 pending |

### 4.3 离线并发与冲突

| 编号 | 场景 | 必须通过的用户结果 |
|---|---|---|
| SYNC-CON-001 | 本地未上传编辑，远端更新同行 | optimistic overlay 不被覆盖，产生正确合并/冲突 |
| SYNC-CON-002 | 两端改不同字段 | 自动合并，无整对象覆盖 |
| SYNC-CON-003 | 两端改同字段 | 保留 base/local/server，可人工解决，不默认按墙钟覆盖 |
| SYNC-CON-004 | 客户端时间未来一天/一年/回拨 | 不获得非法覆盖权 |
| SYNC-CON-005 | `config` 与 `config.x`、数组根/叶子 | 快捷路径和完整路径一致识别重叠 |
| SYNC-CON-006 | 历史库空/缺 field ledger | 强制回填/rebase，不把空账本当无冲突 |
| SYNC-CON-007 | 笔记双方改不同段/同段 | diff3 可合则合，否则 hunk 可见；不能伪 merge |
| SYNC-CON-008 | 连续两次复制冲突副本 | 每次全新 UUID，不撞 `id-copy` |
| SYNC-CON-009 | 远端删除、本地 pending 编辑 | 删除优先；本地编辑转冲突副本，不静默丢失 |
| SYNC-CON-010 | keep local/server/manual merge | 新 opId、新 base、真实 mergedPayload，可跨端收敛 |

### 4.4 Secret、密钥库与锁定状态

| 编号 | 场景 | 必须通过的用户结果 |
|---|---|---|
| SYNC-SEC-001 | 错误 ciphertext/AAD/envelope revision | 整页失败、游标不动、不写 hasX 假状态 |
| SYNC-SEC-002 | hasSecret=true 但 envelope 缺失 | 不得标记成功；按 patch 是否允许保留旧值规则处理 |
| SYNC-SEC-003 | SecretStore 锁定/失败/系统锁屏 | 业务镜像与 secret journal 可恢复，不丢明文、不误清值 |
| SYNC-SEC-004 | 写 secret 后 kill 于 DB/SecretStore 之间 | journal 恢复一致，无半提交和跨账号 ref |
| SYNC-SEC-005 | 主端密钥不可用/轮换 | 上行 defer 而非 envelope-less 上传；旧 epoch 受控迁移 |
| SYNC-SEC-006 | Shared 响应深层 secret canary | 统一出口 fail closed，无长期凭据、Owner key、私钥泄漏 |
| SYNC-SEC-007 | 日志/诊断/活动/AI history 检查 | 不出现明文密码、私钥、完整 prompt、token |

### 4.5 身份、绑定、撤销与迁移

| 编号 | 场景 | 必须通过的用户结果 |
|---|---|---|
| SYNC-ID-001 | 本机有 A 数据，解绑再绑定 B | 无 A 实体/密钥上传 B，无残留串库 |
| SYNC-ID-002 | 首次绑定已有本地库 | 默认不自动上传；导入预览与副本行为符合 D1 |
| SYNC-ID-003 | 撤销同时存在 HTTP/SSE/ZSL/shared/tunnel | 全通道主动失效，不能只等下次 HTTP 检查 |
| SYNC-ID-004 | wipe 离线设备后上线 | 仅清 Linked 与密钥，Local 保留，回报可审计结果 |
| SYNC-ID-005 | 旧 DB 升级、迁移失败、回滚 | 升级前备份可恢复，ledger 不缺失，不丢用户数据 |
| SYNC-ID-006 | 备份恢复/import/清空活动/回收站 | 对端按 mirrorEpoch/tombstone 收敛，无幽灵行 |
| SYNC-ID-007 | registry/协议新旧版本混合 | additive 正确保留，breaking 显式阻止，不静默跳过 |

### 4.6 activityEvent

- 各协议连接成功、认证失败、断开、异常崩溃均有正确事件。
- SFTP 上传、下载、删除、重命名、写入与失败路径均记录。
- 批量执行、AI 工具调用、审批决定具有 run/request 关联。
- 断网产生的事件后传，重复 ingest 不重复显示。
- sourceDevice、时间、outcome、duration 和隐私脱敏正确。
- 活动清空不会让其他端保留与主端定义相矛盾的“全局已清空”状态。

---

## 5. Agent 独立授权测试（D15 必测）

### 5.1 权限交集与本机最终裁决

| 编号 | 场景 | 必须结果 |
|---|---|---|
| AGENT-ACL-001 | Agent 本机只读，主端授予 write | 写入拒绝；不得因主端 admin/Owner 身份放大 |
| AGENT-ACL-002 | Agent 本机允许，主端 ACL 拒绝 | 拒绝；不得绕过主端账号授权 |
| AGENT-ACL-003 | Agent 允许且主端允许，但系统目录授权失效 | 拒绝并提示本机恢复授权，不伪成功 |
| AGENT-ACL-004 | 两台 Agent 配置不同 | 各自独立生效，不把一台配置复制到另一台 |
| AGENT-ACL-005 | 本机 policyGeneration++ | 旧 lease/ticket/stream 失效，主端缓存不能复活 |
| AGENT-ACL-006 | Agent 本机一键暂停/撤销/解绑 | 立即停所有相关操作，主端只能看到真实状态 |
| AGENT-ACL-007 | Agent 本机离线修改策略 | 本机立即生效；恢复在线后按 generation 协调，不被旧主端策略覆盖 |
| AGENT-ACL-008 | 主端要求超范围 share/目标/工具 | Agent 最终拒绝并返回稳定错误，审计不泄漏敏感路径 |

### 5.2 路径、系统权限与 VFS

- `..`、绝对路径、重复分隔符、Unicode 混淆、Windows 驱动器/UNC、保留名、ADS、symlink/junction escape 均不能越过 share root。
- 本地、SMB、SFTP、WebDAV 各后端分别测试 list/stat/read/write/mkdir/delete/rename/truncate；未实现后端明确不可用。
- 大目录、深目录、文件名乱码、并发修改、文件消失、断点续传、磁盘满、只读目录、配额达到上限。
- SAF/Security-Scoped Bookmark 被系统撤销、重装、设备重启后，不绕过系统权限、不把旧 URI 当新目录。
- Agent 与 `agentd` 在相同 share/policy 输入下结果一致，禁止 GUI/headless 行为漂移。

### 5.3 规则求值、网络、剪贴板和 Offload

- 明确 deny 优先于任意 allow；没有匹配 allow 默认拒绝；未知 operation 不得绕过。
- 空 `shares/networkTargets/offloadCapabilities` 分别表示无对应资源权限，不得解释为任意资源。
- 多条 allow 的配额取最小正值；任一显式 0 为禁止；超限必须在副作用前拒绝。
- 删除/reveal/非回环监听/wipe/高危 AI 操作缺少有效 confirmationId、requestHash 不符或确认过期，均返回 `approval_required`。
- 执行前 generation 或系统授权改变时，即使此前允许也必须停止。
- 多 Agent 的同一输入不得互相继承策略；GUI Agent 与 `agentd` 在相同 share/policy 输入下结果一致，禁止 GUI/headless 行为漂移。
- -L/-R/-D 的允许/拒绝矩阵、目标网段/端口限制、端口占用、回环默认。
- `0.0.0.0`/局域网监听必须显式审批，并验证真实监听地址，不可仅看 UI。
- 会话结束、断线、策略收窄、撤销后 listener/forwardIn/连接全部回收，无僵尸端口。
- 文本/文件剪贴板方向按本机配置执行；文件 manifest 不预传全部内容，未授权不能读取内容。
- AI/Cell 的每一个 Offload 子能力独立验证；不得一个总开关让 22 个桥全部隐式开放。
- 高延迟、低带宽、大文件、慢 Agent 时窗口受限、checkpoint 可续传、取消及时、SHA-256 可检出篡改。

---

## 6. Handoff、AI RPC、Shared、WebDAV 测试

### 6.1 Handoff

- 同账号 instant、ask_source、跨用户拒绝/审批、撤销后旧批准失效。
- `epoch++` 原子；A/B 同时请求接管不能双主；旧 epoch 输入被拒绝。
- SSH/Telnet：普通屏幕、vim/htop/tmux、alternate screen、TrueColor、光标、scrollback、不同 cols/rows。
- RDP/VNC：关键帧、尺寸变化、输入焦点、剪贴板、网络断开、重连后 seq 缺口。
- 主端重启按当前阶段明确重连/重建，不宣称内存 session 无损迁移。
- 断言真实上游进程仍运行、输出未丢、输入未重复；不能只检查动画完成。

### 6.2 AI RPC / Cell

- dispatch 重试不重复执行；超时后 result 查询拿到原 run。
- approval 绑定 run/tool/inputHash；修改命令后旧审批无效。
- 高危工具、reveal、非回环监听、跨用户均强制审批。
- AI stream 的 seq、取消、断线、主端退出、Cell crash、旧 epoch 工具有正确终态。
- SecretRef 可还原但不进 prompt/log/history；恶意远端输出不会自动提升工具权限。
- Link/AI/Cell 单 runtime 的 ABI 不匹配、初始化失败、进程退出有真实诊断，不能静默回退到假沙箱。

### 6.3 Shared-to-me

- 目录、打开、refresh、invoke、lease、错误响应均通过统一禁键与白名单出口。
- 深层对象、数组、超过 6 层、错误 canary、缓存头均无敏感泄漏。
- 一次性票据重放、跨设备、过期、并发 attach、旧 generation 全部拒绝。
- Owner 删除/禁用、ACL 撤销、依赖密钥/跳板/代理撤销立即断开。
- 本地数据库、FTS、日志、崩溃转储、通知、云备份均无 shared 内容。

### 6.4 WebDAV Vault

- 独立密码在新设备上可完整恢复连接、密钥、笔记、配置及声明覆盖的实体。
- 错误密码、错 vault、篡改密文、旧 KDF 参数、损坏 manifest 均失败关闭。
- 两台设备同时 manifest 更新触发 CAS 冲突并安全重试，不静默覆盖。
- **B2 并发负例必须真实证明条件写有效**：两个 writer 基于相同 ETag 提交不同 head，最多一个成功；失败者重读重放且不丢 op。若该测试不成立，禁止多写者功能发布。
- 弱/无 ETag、缺 If-Match/If-None-Match、MOVE 不支持、PUT 非原子、超时后结果不确定均按兼容策略处理；**缺强条件写时只能 B0/B1，不得靠“整代快照”或客户端锁文件开放多写者**。
- B1 只有一个持久 writerId；其他设备只读。独占接管需人工操作并生成新 writerEpoch，不能让两个设备周期任务自动交替抢锁。
- B0 只能下载/手工导出，不得自动周期写或宣称备份/同步成功。
- 备份到一半 kill、恢复一半 kill、磁盘满、远端限流、DNS rebinding/SSRF 均有安全结果。
- 恶意删除 op/整库回滚能被签名 head/generation 检出；不会静默覆盖新数据。
- 主端不可用时仍可凭 vault 地址和独立密码恢复，证明不依赖主端环境密钥。

### 6.5 mobile v1 与新业务信封兼容

- v1 `op=bootstrap/changes/push/ack/status` 与 v2 `operation=sync.*` 按 4.2.1 映射，响应仍是原业务 schema，不强塞新 envelope 字段。
- 未协商 v2 的旧 client 只收到 v1 body；v1→v2 适配不得把旧 body 再完整嵌套进新 body 造成双重 envelope。
- `op` 与 `operation` 不一致、body 内外 `deviceId` 不一致、v1 顶层 push 字段与 v2 body 同时出现、未知 op、错误 KIND/operation 组合均拒绝。
- 纯 `has(operation)` 不能作为格式识别依据；必须由 session envelopeVersion/capabilities 协商决定。
- v1 push 的 opId/batchId 幂等语义在转换后不丢；新 requestId 不替换 operation 幂等。bootstrap/changes/status 保持普通只读语义；ack 保持 cursor/appliedOpIds 单调确认，不把不同 ack 错合并。
- 同连接写操作不得并发穿越 v1/v2；相邻 owned-sync、AI、file-bridge lane 不被兼容层错误污染。

---

## 7. 版本兼容、迁移与跨语言一致性

### 7.1 必须测试的版本矩阵

- old client → old server；
- old client → new server；
- new client → old server；
- new client → new server；
- Desktop ↔ Android、Desktop ↔ iOS、Android ↔ iOS；
- GUI Agent ↔ `agentd`；
- Go ↔ Node 的 ZSL/CBOR/codec/error 互操作。

### 7.2 必须保留的字段与状态

- opaque/unknown 字段在 round-trip 中不丢；
- 新增 optional 字段不使旧客户端误删或整包覆盖；
- 新 required 能力缺失时明确 `unsupported_capability`；
- registry hash 变化不误判为全部可兼容；
- 迁移前备份、失败回滚、旧版本重启均不会丢库；
- 二进制内嵌的 Go toolchain、依赖和源码 revision 与交付声明一致。

---

## 8. 故障注入与性能预算

### 8.1 必测故障

- 请求前、发送后、主端已提交未响应、客户端已接收未落库、落库后未 ACK 各阶段断网/kill。
- 响应重复、乱序、丢失、延迟、错误 cursor、错误 generation、伪造 payload。
- 低磁盘、只读 FS、密钥库锁定、内存压力、慢 CPU、系统时间漂移。
- 主端重启、Agent 重启、应用被系统杀死、移动后台回收、锁屏、切换账号。
- 弱网、抖动、高 RTT、限速、频繁断连、MTU/代理/TLS 中间设备异常。
- 恶意/超大/超深 CBOR、JSON、HTML、MIME、文件路径与压缩炸弹。

### 8.2 性能测量口径

- 同步不能只看 HTTP 返回耗时：分别测 op 入队、push、pull、数据库提交、UI 可观察收敛。
- 报告 p50/p95/p99、最大值、错误率、重试次数、内存峰值、CPU、流量和电量/后台限制。
- 大实体、200+ ops、长 AI 消息、大 workspace、大文件和慢 Agent 必须分别测量。
- 终端/AI/文件流必须验证背压和取消，不得无界缓冲。
- 性能环境、设备、网络、数据规模与冷/热启动必须记录；不能把模拟器异常帧率直接归因于被测实现。

---

## 9. CI 分支与产物门禁

1. 所有 Link 相关 workflow 必须覆盖实际开发分支，包括 `zephyr-newui`；不能只监听 `main` 后用旧历史结果代替。
2. 每个 Link 变更必须至少执行以下三条，并保存输出；缺少任一报告不得视为合同检查完成：

```bash
node docs/zephyr-link/verify-docs.mjs
node docs/zephyr-link/conformance/run-conformance.mjs
node docs/zephyr-link/conformance/verify-conformance.mjs
node docs/zephyr-link/conformance/run-source-mutations.mjs
```

3. 上述命令只证明**规范/参考层**。生产适配器必须另跑同目录全部向量及目标平台 E2E，并输出 `production-conformance` 或 `production-e2e` 报告；`productionRequired` 未清零时不得声明完成。
4. 当前提交的 `test/build` 与目标分支/产物 digest 必须一致。
5. Node/Go/跨语言测试、真实主端集成、Android 编译与 instrumentation、iOS Xcode 测试、Desktop 运行时测试分别设 job。
6. **Android/iOS 原生编译不可被静态合同测试替代；缺少 runner/SDK 时状态必须是未验证，不得默认成功。**
7. 每次构建对安装包内的原生库执行 `go version -m` 与 `govulncheck -mode=binary`；检查 toolchain、module、源码 revision。
8. 生成物、schema、黄金向量、CBOR interop、版本号文件必须做 drift 检查。
9. 发布 job 需要所有必需 job 的真实结果和原始 artifact；任何缺失均阻止发布。
10. 安全热修必须能独立出包回滚，不等待大型互联重构全部完成。

---

## 10. 发布验收报告模板

每次候选发布必须附：

```yaml
release:
  commit: <full SHA>
  branch: <actual branch>
  artifacts: <package digest>
  serverVersion: <version>
  clientVersions: <desktop/android/ios/agent versions>
  goToolchain: <per artifact>
  protocolVersion: <version>
  registryHash: <hash>

evidence:
  unit: <run URL + raw report>
  storage: <SQLite/Room/SQLCipher tests>
  interop: <Go/Node/Kotlin/Swift results>
  liveServer: <real server + Go Link results>
  desktopRuntime: <Electron/Tauri results>
  android: <compile + emulator/device results>
  ios: <Xcode + simulator/device results>
  multiDevice: <scenarios and raw logs>
  faultInjection: <kill/offline/revoke/timeout results>
  security: <govulncheck source/binary + secrets scan>
  performance: <raw metrics>

coverageGaps:
  - <honest unverified item>

decision:
  status: GO | NO-GO
  approver: <owner>
  rollback: <artifact and data rollback procedure>
```

**`GO` 只能授予所有必需证据存在且通过的候选版本。`coverageGaps` 含阻断项时，必须 `NO-GO` 或明确降级为实验版本，不能称稳定版。**

---

## 11. 当前必须先落地的回归起点

以下不是假设案例，而是本周期审计中实际定位的问题；修复前应先看到相应测试失败：

- Desktop 本地 revision 作为远端 baseRevision，导致新行 CAS 失败；
- Desktop 把 push 的 serverCursor 错写为 appliedCursor；
- Desktop 未上传编辑被远端覆盖；
- Desktop 删除不产生上传 op；
- Desktop 坏 secret envelope 仍写实体和 hasPassword=true；
- Desktop 换绑无数据域隔离；
- 主端 bootstrap 不是一致快照；
- 嵌套字段冲突快捷判断不一致；
- 历史库空 field ledger 可能误判无冲突；
- Shared 禁键断言未统一覆盖全部响应；
- wake leader 只限进程内；
- 旧 Android Link/AI 二进制携带老 Go toolchain 与漏洞；
- `zephyr-worker` 的 `x/crypto/ssh` 版本存在已知可达漏洞。

**每项修复都必须保留“旧版失败 → 新版通过 → 故障变体通过 → 发布产物复验”的完整证据链。**

[RULES I BROKE]：无。
