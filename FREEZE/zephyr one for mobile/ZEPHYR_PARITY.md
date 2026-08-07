# Zephyr → Zephyr One 原生能力继承规范

> [KNOWN] 基线：`Lanlan13-14/zephyr-ssh` `main@3a61d2f`（2026-08-08）。
>
> [KNOWN] 产品范围仍由 [`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md) 约束；本文只规定 Zephyr 已有解决方案怎样进入原生 Zephyr One。
>
> [INFERRED] 置信度：HIGH。标记为“新建”的部分是实现合同，不代表当前代码已经存在。

## 1. 继承原则

### 1.1 必须继承什么

- [KNOWN] **业务语义继承**：字段、默认值、校验、revision、ACL、敏感验证、错误码、删除规则、审计、备份格式和协议字节必须来自 Zephyr 的现有 service，而不是由移动端另造一套。
- [KNOWN] **服务端业务入口继承**：移动同步 push 必须调用 `ResourceService`、`NotesService`、`UserSettingsService`、`WorkspaceService`、`AiProviderService`、Token/备份 service；不得直接更新业务表。
- [KNOWN] **安全边界继承**：共享资源的 `use` 不等于 `revealSecret`；管理员只获得治理视图，不自动获得其他用户秘密或连接使用权。
- [KNOWN] **兼容协议继承**：ZFT2 v2 的 20 字节大端帧、操作码、flags、大小限制和错误帧保持逐字节兼容。
- [KNOWN] **测试继承**：Zephyr 已有服务级测试先作为 One 合同测试基线，再增加 Android/iOS 解码、UI 和真机测试。

### 1.2 不能机械搬什么

- [KNOWN] `public/*.html`、DOM、iframe、Web xterm、`sessionStorage/localStorage` 和浏览器 Cookie 不是原生 UI 方案；不得用整页 WebView 包装现有页面冒充原生实现。
- [KNOWN] 当前 `/api/one/sync/pull` 是整包 pull-only；它没有 push、change cursor、幂等、冲突和墓碑，不能作为正式原生同步协议。
- [KNOWN] 当前 `agent-tokens.json` v2 含 Token 明文；正式 mobile v1 必须迁移到加密存储和 revision/change-log。
- [KNOWN] 当前 Connection/Proxy/SSH Key/JumpHost 多数是硬删除；完整双向同步必须在业务 service 前增加 tombstone/change hook，不能复制硬删除行为。
- [KNOWN] 当前服务端错误有三种形状：纯 `{error}`、顶层 `{error,code,retryable}`、嵌套 `{ok:false,error:{...}}`；原生客户端必须通过 mobile adapter 收敛为一个错误 envelope。
- [INFERRED] Web 端视觉布局只提供信息层级和行为参考；原生端使用 Compose/SwiftUI 组件、系统 sheet、系统键盘、系统文件选择器和无障碍语义。

## 2. Zephyr 事实源和 One 落点

| 领域 | Zephyr 事实源 | 已有规则 | Zephyr One 原生落点 |
| --- | --- | --- | --- |
| 身份与会话 | `server.js`、`session-store.js` | [KNOWN] SID 随机生成，DB 只存 SHA-256；idle + absolute TTL；撤销覆盖缓存 | [INFERRED] SID 只用于绑定/管理 API，存 Keystore/Keychain；绑定后数据面改用短期 device access + proof |
| 登录策略 | `server.js /api/auth/login`、`/totp/verify` | [KNOWN] IP/CAPTCHA/锁定/默认密码/TOTP/停用均由主端判定 | [KNOWN] One 不配置这些策略；原生登录展示稳定 code，CAPTCHA 用系统认证会话 |
| 敏感验证 | `verifySensitiveAccess` | [KNOWN] 开 TOTP 时只收当前 TOTP；未开 TOTP 时收当前密码 | [INFERRED] `/mobile/v1/sensitive/verify` 包装为短时、单次、action+targets 绑定 grant |
| ACL | `authz.js` | [KNOWN] 13 个 capability、owner 全权、admin 仅 metadata view、无权时防枚举 | [KNOWN] 原生 UI 按 capability 隐藏/禁用操作；服务端继续最终裁决 |
| 连接 | `storage.js`、`resource-service.js`、`server.js` | [KNOWN] owner-aware CRUD、依赖 ACL、revision、secret masking | [KNOWN] 原生连接库/编辑器完整复刻字段与默认值；本地 mirror 不能放明文 secret |
| 笔记 | `notes-service.js` | [KNOWN] expectedRevision、软删/恢复/永久删除、分组/标签/关联、AI read/write 分权 | [KNOWN] 原生 Markdown 工作区复用相同限制和错误码 |
| 工作区 | `workspace-service.js` | [KNOWN] 256 KiB、每用户 20 个、90 日清理、secret scrub、恢复时重新检查 ACL | [KNOWN] 手机保存会话顺序/最小化/选中项；不自动重放命令或输入 |
| 深链 | `deeplink-service.js` | [KNOWN] ssh/telnet/jms、60 秒、用户绑定、一次消费、credential 加密 | [KNOWN] App/Universal Link 解析后使用同一 draft/consume 语义 |
| 设置 | `user-settings-service.js` | [KNOWN] 系统强制 > 用户 override > 管理员默认 > built-in；普通用户白名单写入 | [KNOWN] One 只展示有移动用途 key；未知/排除 key opaque 保留 |
| AI Provider | `ai-provider-service.js` | [KNOWN] owner/共享、provider 类型、模型可见性、API Key 加密 | [KNOWN] 原生 AI UI 复用主端 runtime API 与 provider 权限，不在客户端绕过模型许可 |
| Snippet | `ai-snippet-tools.js`、`user_settings.snippets` | [KNOWN] 500 条、revision、名称/命令/分组长度限制 | [INFERRED] 服务端先正规化为可单项同步实体；原生端不整包覆盖 snippets 数组 |
| 活动 | `storage.js activities` | [KNOWN] 账号过滤、最多 500 查询、结构化 category/outcome/target 等字段 | [KNOWN] 首页活动二级页；append-only，同 eventId 去重 |
| 备份恢复 | `/api/data/export`、`/api/data/import` | [KNOWN] WAL checkpoint、DB+manifest+数据密钥、ZIP 后 AES-GCM、导入前本地 DB 回滚副本 | [KNOWN] One 原生文件导出/导入 UI；执行仍在主端；保留 super-admin 与登录密码门 |
| Client Token | `file-agent-manager.js` | [KNOWN] 多 Token、创建/改名/查看/旋转/删除/重置、关联 Agent 立即断开 | [INFERRED] 迁移进 SQLite 加密表，增加 ownerUserId/revision/tombstone/change hook；One 可完整互备 secret |
| 文件桥接 | `file-agent-manager.js`、`file-transfer-protocol.js` | [KNOWN] ZFT2 v2、1–16 inflight、最大 1 MiB payload、取消和错误帧 | [KNOWN] Android/iOS 实现相同字节协议；用户可见名称统一为“文件同步/文件桥接” |
| 终端移动输入 | `FREEZE/WTERM_MOBILE_VIEWPORT_CONTRACT.md` | [KNOWN] 单一滚动写入口、composition 不滚、IME 几何和 cursor 约束 | [INFERRED] 原生终端 core 继承行为不继承 DOM；Compose/SwiftUI 只有一个 SurfaceController |

## 3. 身份、会话与绑定

### 3.1 登录状态机

```text
ENTER_SERVER
  → FETCH_CAPABILITIES
  → ENTER_CREDENTIALS
  → POST /api/auth/login { returnSid:true }
      ├─ requireTotp=true → ENTER_TOTP → POST /api/auth/totp/verify
      ├─ captcha_required → SYSTEM_AUTH_SESSION → callback → retry
      ├─ must_change_password → SYSTEM_BROWSER_REQUIRED_ACTION
      ├─ account_locked/suspended → BLOCKED
      └─ sid → TOKEN_SELECTION
  → DEVICE_KEY_GENERATION
  → POST /api/mobile/v1/devices/bind
  → BOOTSTRAP
```

- [KNOWN] 原生请求必须带 `X-Zephyr-One-Client: 1` 或 `returnSid: true`；主端才会在 JSON 中返回 SID。
- [KNOWN] SID 不写普通 preferences，不进入日志、analytics、crash metadata 或同步实体。
- [KNOWN] `userId` 是账号归属权威；username 只是显示和旧 Token owner 兼容键。
- [KNOWN] 主端零 Client Token 时绑定返回 `token_required`，One 只显示去主端创建 Token 的引导和“重新检查”，不得自动创建。
- [INFERRED] 绑定成功后服务端返回 access credential、single-use refresh credential、registry hash；refresh 每次成功都旋转，旧值再用返回 `refresh_replayed`。

### 3.2 会话继承

- [KNOWN] Zephyr SID 使用 idle TTL 与 absolute TTL，普通/remember TTL 由服务端配置决定；移动端不得假设固定天数。
- [KNOWN] 密码重置、账号停用、管理员撤销和 logout 会撤销服务端 session。
- [INFERRED] One 收到 `app_session_expired` 时停止管理操作；已绑定数据面可否继续由 device 状态决定，不能把 SID 过期误判为设备必然撤销。
- [INFERRED] One 收到 `client_revoked/token_missing/account_unavailable` 时立即停止上传、锁住未下发的 secret、保留本地非敏感镜像并进入重新绑定页。

## 4. ACL 与共享

### 4.1 固定 capability

```text
discover, view, use, observe, control, execute,
fileRead, fileWrite, edit, share, delete, revealSecret, administer
```

- [KNOWN] Owner 拥有全部 capability。
- [KNOWN] Admin 对他人私有资源默认只有 metadata `view`，没有 `discover/use/revealSecret`。
- [KNOWN] `shared_users/shared_admins/shared_all` 只隐式授予 `discover/view/use/observe`。
- [KNOWN] 显式 ACL grant 可授予 capability 并设置 expiresAt；撤销和过期立即生效。
- [KNOWN] 不存在和不可发现资源对普通调用者统一为 `resource_not_found_or_inaccessible`，防止枚举。

### 4.2 原生 UI 规则

| capability | One UI |
| --- | --- |
| `discover` | [KNOWN] 资源进入列表 |
| `view` | [KNOWN] 可打开只读详情 |
| `use` | [KNOWN] 可连接/调用；仍不显示 secret |
| `observe` | [KNOWN] 可观察会话状态 |
| `control` | [KNOWN] 可发送交互控制 |
| `execute` | [KNOWN] 可进入批量命令目标集合 |
| `fileRead/fileWrite` | [KNOWN] SFTP/文件桥接分别启用读取/写入操作 |
| `edit` | [KNOWN] 显示保存操作，否则表单只读 |
| `share` | [KNOWN] 显示共享 sheet |
| `delete` | [KNOWN] 显示删除操作 |
| `revealSecret` | [KNOWN] 允许发起敏感验证后查看；没有时永不向设备下发 owner secret |
| `administer` | [KNOWN] 只用于有产品用途的治理操作，不等于 secret 权限 |

- [KNOWN] 客户端禁用只是体验；每次服务端操作仍重新计算 capability。
- [KNOWN] 连接依赖的 SSH Key、Proxy、JumpHost、Jump Connection 在保存和使用时都重新检查；共享 Connection 不隐式共享依赖。
- [KNOWN] 工作区恢复、离线缓存重新联网和 ACL change feed 应用后都重新裁剪资源能力。

## 5. 连接模型完整继承

### 5.1 通用字段和默认值

| 字段 | Zephyr 规则 | One 规则 |
| --- | --- | --- |
| `id` | [KNOWN] 随机 UUID | [KNOWN] 原样同步，不以 host 生成 |
| `protocol` | [KNOWN] SSH/TELNET/RDP/VNC | [KNOWN] 原样；未知枚举只读保留 |
| `port` | [KNOWN] 22/23/3389/5900 | [KNOWN] 协议切换时仅未手改端口跟随默认 |
| `name` | [KNOWN] 持久连接必填；临时连接可从协议+host 生成 | [KNOWN] 相同 |
| `host` | [KNOWN] 必填 | [KNOWN] 前后空白去除，服务端最终校验 |
| `username` | [KNOWN] SSH 必填，其他协议可空 | [KNOWN] 相同 |
| `password/privateKey` | [KNOWN] 加密保存，列表只回 `******` + has 标记 | [KNOWN] SecretStore 引用；masked 值永不回写覆盖 |
| `tags` | [KNOWN] 字符串数组 | [KNOWN] 去空值，保持顺序和未知 Unicode |
| `connectionMode` | [KNOWN] direct/proxy/jump | [KNOWN] 切换模式清除不相关 dependency id |
| `jumpHostIds` | [KNOWN] 去重有序数组；兼容旧 `jumpHostId` | [KNOWN] 编辑器以有序多级链展示 |
| `revision` | [KNOWN] 从 1 开始，编辑递增 | [KNOWN] 每次 push 带 baseRevision |
| `ephemeral` | [KNOWN] 一次性连接不进库列表，默认 6 小时清理 | [KNOWN] 设备本地会话字段，不进入账号镜像 |
| `encoding` | [KNOWN] 默认 UTF-8；Telnet 可 GBK/Big5/Latin-1 | [KNOWN] 原样 |

### 5.2 RDP 字段

| 字段 | 允许值/默认值 |
| --- | --- |
| `rdpSoundMode` | [KNOWN] `local / remote / off`，默认 `local` |
| `rdpClipboard` | [KNOWN] boolean，默认 `true` |
| `rdpMicrophone/rdpCamera/rdpStorage/rdpLocation` | [KNOWN] boolean，默认 `false` |
| `rdpResolution` | [KNOWN] `auto / 1080p / 2K / 4K / 8K`，默认 `1080p` |
| `rdpQuality` | [KNOWN] `balanced / performance / quality`，默认 `balanced` |
| `rdpFps` | [KNOWN] `30 / 45 / 60 / 120 / 144`，默认 `30` |
| `rdpTouchMode` | [KNOWN] `direct / relative`，默认 `direct` |
| `rdpTouchSensitivity` | [KNOWN] `0.5…3.0`，默认 `1.5` |
| `rdpDomain` | [KNOWN] Windows domain 字符串 |
| `rdpPipeline` | [KNOWN] 当前 Web 强制 `worker-gpu-v2` | [INFERRED] One 原生端把它当 opaque Web 字段，不用它选择 native renderer |

### 5.3 保存语义

- [KNOWN] `password/privateKey/passphrase/apiKey/token` 的 masked 占位符绝不视为新秘密。
- [KNOWN] Connection 创建/编辑必须先检查依赖是否存在且当前用户有 `use`。
- [KNOWN] 删除资源同时撤销该资源全部 ACL。
- [INFERRED] 正式 mobile v1 删除先写业务 tombstone 和 change log，再由 retention job 物理清理；依赖资源删除前服务端返回引用列表。
- [KNOWN] `lastConnectedAt` 是服务端/本机活动字段，不参与用户字段冲突。

## 6. 协议会话继承

### 6.1 SSH/SFTP

- [KNOWN] 认证来源按连接内联 private key/password 与 `sshKeyId` 解析；key passphrase 可作为对应私钥口令。
- [KNOWN] route 支持 direct、SOCKS5/HTTP CONNECT proxy、SSH jump chain；每层依赖必须有 `use`。
- [KNOWN] host key 变化不能静默接受；One 显示算法、SHA-256 fingerprint、host、port。
- [INFERRED] One 的 native SSH engine 必须暴露 `connect/openPty/resize/write/openSftp/close` 小接口；UI 不接触协议 packet。
- [KNOWN] SFTP 的 `fileRead/fileWrite` capability 独立；只读共享不得因为 `use` 而写文件。

### 6.2 Telnet

- [KNOWN] 默认端口 23，支持 IAC、NAWS、TTYPE、BINARY、ECHO、SGA。
- [KNOWN] 用户名/密码用于 in-band auto-login；Telnet 清除 SSH private key/sshKeyId，但仍可通过 proxy/jump 走 TCP route。
- [KNOWN] 支持 UTF-8、GBK、Big5、Latin-1；UI 始终显示明文协议风险。
- [INFERRED] 原生 Telnet parser 直接移植 Zephyr 状态机和测试向量，不把 WebSocket `/ssh` 当原生数据面。

### 6.3 RDP

- [KNOWN] Zephyr 已有证书探测、首次信任/变化阻断、声音、剪贴板、输入、触控和文件映射语义。
- [INFERRED] One 使用 native RDP core；Compose/SwiftUI 只承载 Surface/UIView、手势、系统通道权限和状态。
- [KNOWN] 麦克风、摄像头、位置、目录权限按会话实际请求懒申请；拒绝单个通道不应让整个会话失败。
- [INFERRED] 只读 drive 必须在 provider 层拒绝 open-write、write、truncate、mkdir、rename、delete；只设置 UI `readOnly` 不构成安全实现。

### 6.4 VNC

- [KNOWN] Zephyr 产品语义包含认证、像素格式、增量 framebuffer、剪贴板、输入和重连。
- [INFERRED] One 复用 native RFB core；不支持的 security type 返回稳定错误，不自动降级到未知弱模式。

## 7. 笔记、Snippet、工作区与 Deep Link

### 7.1 笔记

- [KNOWN] 标题最长 200 字符；正文最多 1 MiB UTF-8；标签最多 100；关联连接最多 100；bulk 最多 200。
- [KNOWN] 更新必须带 `expectedRevision`；不匹配返回 `note_revision_conflict`。
- [KNOWN] 普通删除进入回收站；恢复 revision +1；永久删除默认只允许回收站内项目。
- [KNOWN] AI 读取与 AI 编辑是两个独立开关；AI 编辑隐含读取，关闭读取同时关闭编辑。
- [KNOWN] 分组重命名只改精确路径，不递归改子路径；删除分组把笔记移到未分组。
- [KNOWN] Markdown 导出文件名清洗；原生预览不能执行 HTML script。

### 7.2 Snippet

- [KNOWN] 最多 500 条；name 1–60；command 1–20000；group 最多 40；id 最多 120。
- [KNOWN] update/delete 需要 expectedRevision；冲突返回 `revision_conflict`。
- [INFERRED] mobile v1 把每条 snippet 正规化为独立 change/tombstone，禁止用整个 `user_settings.snippets` 数组 last-write-wins。
- [KNOWN] `autoRun` 在执行前仍服从目标 Connection 的 `execute` capability 和危险操作确认。

### 7.3 工作区

- [KNOWN] 单条 state JSON 最大 256 KiB；每用户最多 20 个；默认 90 天清理。
- [KNOWN] state 递归删除 password/privateKey/passphrase/apiKey/token/totpSecret/credential 等字段。
- [KNOWN] restore 对每个 connectionId 重新检查当前 ACL，并返回 `accessible/reason/capabilities`。
- [KNOWN] restore 永远 `autoReplay:false`；不自动重发终端输入、命令或 AI 工具调用。
- [INFERRED] One 的 `clientId` 是设备本地布局槽，不作为认证，不跨设备覆盖；可移植会话定义单独同步。

### 7.4 Deep Link

- [KNOWN] URI 最长 8 KiB；JMS 解码 JSON 最大 16 KiB；端口范围 1–65535。
- [KNOWN] 支持 `ssh://`、`telnet://`、`jms://`；JMS `sftp` 映射为 SSH + `autoOpenSftp`。
- [KNOWN] 临时 credential 只存加密 blob，token 只存 SHA-256，默认 60 秒，绑定 userId，正式消费一次后擦除。
- [KNOWN] 测试连接可在过期前复用 token，但不延长 TTL，也不消费。

## 8. 设置与服务器管理

### 8.1 One 可操作设置

- [KNOWN] 用户设置继承合并顺序：系统强制 > 用户 override > 管理员默认 > built-in。
- [KNOWN] One 可编辑移动有用途字段：主题、四色 scheme、终端背景/字体、终端窗口偏好、笔记偏好、移动工作区偏好、AI 面板/名称、Snippet。
- [KNOWN] One 不提供账号安全、SMTP、CAPTCHA/IP 策略、备案、自定义 CSS/JS 编辑入口。
- [KNOWN] 未知或排除字段存在于快照时只能 opaque preservation；One 的 fieldMask 不得包含它们。

### 8.2 保留的服务器设置

- [KNOWN] “服务器设置必须保留”不等于复制全部 Web 部署后台。
- [INFERRED] 工具 → 服务器 → 设置只展示当前账号在 Zephyr 中有权限且对移动操作有用途的 section：appearance、notes、AI runtime 开关/模型可用性、运行状态和兼容信息。
- [KNOWN] API 继续使用 `requireAdmin/requireSuperAdmin`；普通账号看到 capability/role 不足状态，不伪装保存成功。
- [KNOWN] security/mail/captcha/beian 不进入 One 页面，即使调用者是 super-admin。

### 8.3 备份恢复

- [KNOWN] 导出执行 WAL checkpoint，包内包含 `zephyr.db`、manifest 和文件型 ML-KEM 数据密钥；外层使用 AES-256-GCM `ZEPHYR3` 格式。
- [KNOWN] 导入要求 super-admin 和当前登录密码；错误密码、缺 DB、错误加密包均不得改现有数据。
- [KNOWN] 导入前复制 `zephyr-before-import-<time>.db`；DB 或密钥恢复失败时回滚旧 DB 和旧 key，再 reopen storage。
- [INFERRED] 原生 One 使用系统 document exporter/importer；大文件上传显示字节进度，App 切后台时保持可恢复 job 状态，不在内存复制多份 archive。

## 9. AI 能力继承

- [KNOWN] Provider 类型固定为 `openai/openai-compatible/anthropic/gemini/ollama`。
- [KNOWN] Provider 可 private、共享给 users/admins、共享给选定用户；共享使用不下发 API Key。
- [KNOWN] 模型必须在 provider owner 允许的模型集合且未隐藏；否则 `model_not_allowed/model_hidden`。
- [KNOWN] AI 工具继续经过 Zephyr capability registry、确认策略、ACL 和 notes AI read/write 开关；One 不在客户端复制一套弱化鉴权。
- [KNOWN] AI Session/run/messages/usage/events 直接使用主端 runtime API；离线时只读本地已同步会话和草稿，不假装模型可用。
- [INFERRED] 在 mobile v1 纳入 AI conversation/message 前，必须先把当前 runtime 的 canonical schema、revision、附件 manifest 和删除规则落进 `entity-registry.json`；状态为 blocked 时不得宣称完整镜像。
- [KNOWN] AI Env 的值是 secret；列表只显示 `hasValue`，查看/同步进入设备 envelope 和 SecretStore。

## 10. Client Token 与文件同步

### 10.1 Token

- [KNOWN] Token name 最长 80；secret 长度限制 16–256，当前默认 50；tokenId 稳定，旋转改变 secret 而不改逻辑 id。
- [KNOWN] 查看、旋转、删除、重置全部必须走密码/TOTP敏感验证。
- [KNOWN] 旋转/删除后使用该 tokenId 的旧 Agent 和 One 设备立即断开；其他 Token 不受影响。
- [INFERRED] 正式表以 immutable `owner_user_id` 归属；旧 `ownerId=username` 只作迁移输入。
- [INFERRED] `agent-tokens.json` 导入事务完成后改名为只读迁移备份，不能继续双写明文 JSON。

### 10.2 ZFT2

- [KNOWN] magic=`ZFT2`，version=2，header=20 bytes，所有整数大端。
- [KNOWN] flags：error=`0x0001`，response=`0x0002`。
- [KNOWN] metadata 最大 256 KiB；payload 最大 1 MiB；实际 chunk 由双方 capability 取最小值。
- [KNOWN] 操作码：OPEN 01、READ 02、WRITE 03、CLOSE 04、STAT 05、LIST 06、MKDIR 07、DELETE 08、RENAME 09、TRUNCATE 0A、CANCEL 0B、PING 0C。
- [KNOWN] `maxInflight` 限制 1–16；默认 8；disconnect 关闭所有 handle 并拒绝 pending request。
- [KNOWN] readOnly provider 必须拒绝所有写语义；客户端 UI 禁用不代替 provider 检查。

## 11. 错误与客户端动作

- [KNOWN] 机器错误真源为 [`contracts/error-registry.json`](contracts/error-registry.json)。
- [KNOWN] 新响应统一为：

```json
{
  "ok": false,
  "error": {
    "code": "note_revision_conflict",
    "message": "笔记已被其他人更新，请重新加载",
    "retryable": false,
    "details": {},
    "requestId": "srv_..."
  }
}
```

- [KNOWN] One 只根据 `code` 分支；`message` 可直接展示但不参与逻辑。
- [KNOWN] 401 只自动 refresh 一次；403 不无限重试；409 进入冲突/重新 bootstrap；429 遵守 `Retry-After`；网络/5xx 指数退避并加 jitter。
- [INFERRED] mobile adapter 保留旧 `error` 字符串字段给 Web 兼容，但 native SDK 只暴露统一 `MobileError`。

## 12. 不得偏离的测试继承

| Zephyr 测试事实 | One 必须增加的对等测试 |
| --- | --- |
| [KNOWN] `authz.test.mjs` 覆盖 owner/admin/陌生人/过期 grant/防枚举 | [INFERRED] Android/iOS capability decoder + 逐操作 UI gate + 服务端拒绝回归 |
| [KNOWN] `auth-hardening.test.mjs` 覆盖账号锁定、TOTP 尝试耗尽、reset token | [INFERRED] 原生登录状态机不会绕过或无限重试 |
| [KNOWN] `one-client-manager.test.mjs` 覆盖 token 前置、撤销、interval clamp | [INFERRED] mobile v1 bind/refresh/proof/replay/registry tests |
| [KNOWN] `notes-deeplink.test.mjs` 覆盖 revision/软删/一次性 token/工作区 ACL | [INFERRED] 同 fixture 由 Kotlin/Swift 解码并跑离线 round-trip |
| [KNOWN] `file-transfer-protocol` 测试覆盖 magic/length/flags | [INFERRED] Node/Kotlin/Swift golden frame 逐字节一致 + fuzz |
| [KNOWN] `zephyr-one-backup-restore.test.mjs` 覆盖真实导出、错误密码、正确恢复 | [INFERRED] Android/iOS 系统文件选择、上传中断恢复、服务重启后状态 |
| [KNOWN] Telnet tests 覆盖 default port、proxy/jump、GBK、auto-login、reattach | [INFERRED] native parser/route/IME 真机矩阵 |
| [KNOWN] 移动终端测试覆盖 CJK composition、IME event path、scroll policy | [INFERRED] Compose/SwiftUI surface controller instrumentation/UI tests |

## 13. 完成定义

- [KNOWN] “已搬到 One”必须同时满足：字段合同、服务调用、原生页面、离线行为、同步分类、错误码、Android 自动测试、iOS 自动测试、至少一台真机验收。
- [KNOWN] 只有 README 描述、只有页面、只有 pull snapshot、只有 masked metadata 或只有 Android 单端均不算完成。
- [INFERRED] 需求到实现的逐项状态以 [`TRACEABILITY.md`](TRACEABILITY.md) 为发布门，当前真实状态以 [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) 为准。
