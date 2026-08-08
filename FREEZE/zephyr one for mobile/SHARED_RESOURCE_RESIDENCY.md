# Zephyr One 共享资源零驻留与按次使用合同

> [KNOWN] 本合同适用于“其他用户拥有、通过 Zephyr ACL 分享给当前绑定账号”的资源。绑定账号自己拥有的资源仍按完整双向镜像合同处理。
>
> [KNOWN] 核心原则：共享资源不加入 One 的本地镜像，不写本地业务 DB、SecretStore、搜索索引、系统备份、日志、通知正文、诊断包或离线导出；每次查看/使用都在线向 Zephyr 请求并重新检查 ACL。
>
> [KNOWN] 共享资源的 `use/view/fileRead` 从不等于 `revealSecret`。Client Token、Zephyr SID/refresh、设备私钥、服务器 data key、AI Provider API Key、AI Env secret、共享资源 owner 的 Token 与管理凭据绝不作为共享 payload 下发。

## 1. 安全事实与术语

- [KNOWN] TLS + device envelope 能保护网络传输；不能让已在 One 进程中解密的明文免受 root/jailbreak、进程注入、内存 dump、恶意键盘或屏幕捕获。
- [KNOWN] “用完即焚”在移动进程里只能是 **best-effort memory zeroization + 不持久化 + 短寿命**，不能被描述为数学上保证秘密从未出现在设备。
- [KNOWN] 如果资源拥有者要求连接秘密绝不进入 One，唯一符合语义的方案是 Zephyr 主端代执行/relay；native direct connection 与“秘密不进入设备”不能同时成立。
- [INFERRED] `Owned mirror`：`ownerUserId == boundUserId`，可进入完整 sync。
- [INFERRED] `Shared reference`：只由在线响应短暂呈现的 `resourceType/resourceId/displayName/ownerDisplayName/capabilities/revision/expiresAt`，不得持久化。
- [INFERRED] `Use envelope`：给单个 device、session、resource、purpose 的短时加密连接材料；不含控制面 secret。
- [INFERRED] `Server relay`：Zephyr 解密并持有 secret，One 只发送输入/动作并接收输出/画面/脱敏结果。

## 2. 同步与本地驻留边界

### 2.1 Mobile sync

- [KNOWN] `/sync/bootstrap`、`/sync/changes` 和 `/sync/push` 只处理当前绑定用户**拥有**的实体；shared-to-me 不进入 entity pages、change feed、tombstone、opaque snapshot 或 local search。
- [KNOWN] `resourceAcl` 只同步当前用户自己拥有资源的 ACL 管理状态；“别人分享给我”的 grant 不进入镜像，只在在线 shared API 返回。
- [KNOWN] 服务端 sync adapter 对每个 entity 强制 `ownerUserId == authenticated userId`；不能相信客户端请求里的 ownerId。
- [KNOWN] One apply transaction 二次检查 owner；不等于 bound user 时返回/记录 `shared_residency_violation`，整页不推进 cursor，并删除该意外 row 的任何临时文件。
- [KNOWN] shared metadata 也不进入 Room/GRDB、FTS、recent、shortcut、widget、handoff、Spotlight/AppSearch、系统 clipboard history 或备份。
- [INFERRED] UI 的“最近共享”只能在当前进程内短暂保存 resource id 与显示文本，锁屏、账号切换、memory warning、后台超时或进程结束即丢弃；重新进入必须请求主端。

### 2.2 在线共享目录 API

[INFERRED] 新建只读在线接口，不复用 sync：

```text
GET  /api/mobile/v1/shared?type=&cursor=
GET  /api/mobile/v1/shared/{resourceType}/{resourceId}
POST /api/mobile/v1/shared/{resourceType}/{resourceId}/invoke
POST /api/mobile/v1/shared/connections/{connectionId}/sessions
POST /api/mobile/v1/shared/sessions/{sessionId}/refresh
DELETE /api/mobile/v1/shared/sessions/{sessionId}
```

- [INFERRED] 每次请求绑定 `userId + deviceId`，重新计算 user status、role ceiling、grant expiry/revoke、resource revision 和 dependency ACL。
- [KNOWN] 404 合并“不存在/无权”，防止枚举；撤销/过期不能靠缓存延迟。
- [INFERRED] 列表响应 `Cache-Control: no-store, private`，没有稳定离线 cursor；分页 token 只对短快照有效。

## 3. 共享连接：原生直连与严格 relay

### 3.1 Session open

[INFERRED] One 请求：

```json
{
  "mode": "direct-ephemeral | relay-strict",
  "clientSessionNonce": "base64url-128bit+",
  "requestedChannels": ["terminal", "clipboard", "audio", "drive"],
  "deviceKeyVersion": 1
}
```

Zephyr 必须：

1. [KNOWN] 校验当前账号 `use`；根据协议校验 `observe/control/execute/fileRead/fileWrite`。
2. [KNOWN] 服务端解析 Connection、Proxy、SSH Key、JumpHost 依赖并逐项检查 owner/use，沿用 `ResourceService.resolveForConnect` 语义。
3. [INFERRED] 为 `deviceId + sessionId + resourceId + revision + purpose + nonce + expiresAt` 生成一次 session grant。
4. [INFERRED] direct 模式把最小连接材料封装成 device-bound use envelope；relay 模式不返回秘密。
5. [KNOWN] 写审计：actor、owner、resource、mode、capabilities、device、时间、结果；不记 host password/key/token。

### 3.2 Direct-ephemeral use envelope

- [INFERRED] 只允许 SSH/Telnet/RDP/VNC 原生 core 建立该次连接所需的最小字段：endpoint、username、password/private key/passphrase、domain、proxy/jump chain、host/cert policy。
- [KNOWN] 不包含 Client Token、AI Provider Key、Env secret、Zephyr data key、owner SID、refresh token、resource edit payload 或 `revealSecret` 数据。
- [INFERRED] envelope 使用 `ML-KEM-768+HKDF-SHA256+AES-256-GCM`，AAD 额外绑定 `shared-use-v1/serverId/userId/deviceId/sessionId/resourceId/revision/purpose/expiresAt/clientNonce`。
- [INFERRED] TTL 默认 30 秒用于开连；单次成功消费后不能重新下载。网络握手需重试时由仍有效 session grant 重新签发新 nonce envelope，而不是缓存旧密文。
- [KNOWN] One 不把 envelope 或明文写 Room/GRDB、KeyStore/Keychain、文件、preferences、logs、crash breadcrumbs、analytics、clipboard 或 saved state。
- [INFERRED] native `SessionSecretArena` 使用可锁页/guarded memory 时启用；避免不可控 String/Swift String/Kotlin String，使用 mutable byte buffer；解密后只把 scoped view 交 adapter。
- [INFERRED] handshake 完成即清零不再需要的密码/key bytes；session core 内部复制必须审计。断开、失败、取消、后台超时、memory warning、账号锁定、ACL revoke 都触发销毁。
- [KNOWN] GC/ARC、第三方 native library 和 OS swap 使绝对清零不可证明；UI 必须称“仅本次会话、不会保存”，不能称“设备从未获得秘密”。

### 3.3 Relay-strict

- [INFERRED] SSH/Telnet：Zephyr 主端建立 upstream，One 通过 device-authenticated multiplexed stream 传 PTY input/resize，接收 output/exit；凭据不离开主端。
- [INFERRED] RDP/VNC：复用/扩展主端 remote proxy，把图形、输入、音频、剪贴板按 capability 转发；owner 可对 clipboard/file/audio/mic/camera/location 设置 channel policy。
- [INFERRED] relay credential 与 session/device/resource/capability/expiry 绑定；不是 Client Token，不可访问其他资源。
- [KNOWN] relay 仍会把终端输出、远程画面和用户传输内容带到 One；“秘密不下发”不等于“会话内容不敏感”。One 不持久化 shared transcript/frame/clipboard。
- [INFERRED] owner policy 可强制 relay；One 用户不能降级到 direct。relay 不可用时明确报错，不能静默下发 secret。

## 4. 共享 AI：只请求主端代执行

- [KNOWN] Zephyr AI runtime、Provider API Key、Env secret、Memory/Skills、tool execution 和 shared resource secret 保留在 Zephyr 主端；One 是原生浮窗 client，不在设备本地重建 shared AI execution。
- [KNOWN] 每次 AI run/continue/tool confirm 都携带 device access、runId、当前 context reference；Zephyr 主端重新校验当前账号、provider/model visibility、AI permission、resource ACL、note allowAiRead/Write 和 tool capability。
- [KNOWN] One 收到的只是 stream event、脱敏 tool trace、confirmation、result/verification 和用户有权看的内容；不得收到 Provider key、Env value、Client Token 或工具内部 resolved credentials。
- [KNOWN] 共享 Connection/Proxy/Key/JumpHost 的 AI 操作由主端 canonical tool/service 执行；`use` 允许主端连接，不允许 AI 或 One 获取 `revealSecret`。
- [KNOWN] `ui_action` 在 One 通过 `NativeSurfaceBridge` 操作当前设备 UI，但 action 仍由主端签发 scoped intent、One 本地 capability check、用户 confirmation 三层约束；不得附带共享 secret。
- [INFERRED] AI conversation/message 若包含共享笔记正文、终端输出、remote capture 或文件内容，默认只保存在主端 canonical conversation；One 仅按页在线读取，内存中虚拟化呈现，锁屏/后台超时清除已加载 page。
- [INFERRED] 用户主动复制、导出、下载 AI 结果属于明确的人为数据外流动作，需显示共享来源和 owner policy；默认关闭 shared content 自动进入系统剪贴板/文件。

## 5. 共享笔记：主端授权读取，不落本地镜像

- [KNOWN] shared note 不进 mobile sync，不写本地 note table/FTS/草稿恢复/系统搜索/Widget；列表和正文每次从 Zephyr 请求。
- [KNOWN] 打开正文要求实时 `view`；编辑要求 `edit` + expectedRevision；AI 读取/写入还要求 note 的 `allowAiRead/allowAiWrite`。撤销/过期后下一请求立即 404/forbidden，不展示离线副本。
- [INFERRED] 正文仅驻留当前 viewer/edit session 的 mutable memory buffer；离页、保存/取消、锁屏、后台超时、memory warning、账号切换、ACL revoke 即清除。
- [INFERRED] shared draft 不写数据库。网络中断时保留在内存并显示“未保存”；App 被系统杀死可能丢失，这是零驻留的明确取舍。
- [KNOWN] 编辑保存必须主端 canonical `NotesService.update(expectedRevision)`；冲突时重新拉取主端版本，不能把 shared note 拷成当前用户 owned note 来偷偷保留。
- [INFERRED] owner policy 可禁止 copy/share/screenshot/export；One 在能力可控范围内执行 FLAG_SECURE/敏感屏幕、隐藏系统 preview、禁用 UI action，但不能声称阻止外部摄像。

## 6. 其他共享资源

| 资源 | One 可短暂显示/使用 | 永不落地/永不下发 |
| --- | --- | --- |
| Connection | 脱敏 metadata、capabilities、会话状态 | shared row、密码/key；direct 例外仅 session arena |
| Proxy/SSH Key/JumpHost | 名称/依赖状态；主端解析 | secret、完整 private key、passphrase |
| Note | 按页正文、内存 draft | DB/FTS/offline/cache/backup |
| Terminal session | live output/input/exit；内存 scrollback | transcript、command history、credential |
| RDP/VNC | live framebuffer、pointer state | screenshot/frame cache、clipboard history、credential |
| SFTP/Agent file | 按次 list/read stream | 自动下载、thumbnail/index；用户主动保存需显式授权 |
| Docker/monitor/log | live query/result | shared log archive、connection secret |
| AI | events/trace/result/confirmation | provider key、env secret、resolved credential、local shared conversation mirror |
| ACL grant | 在线 capability/expiry/owner display | 本地 ACL mirror；当前用户不是 owner 时不可管理 |

[KNOWN] OS 为当前显示创建的 compositor surface、keyboard buffer、socket buffer 不等于产品持久化，但必须启用平台合理保护：敏感窗口/scene preview 遮挡、日志脱敏、crash dump 排除、pasteboard 过期/本地 only（用户主动复制时）。

## 7. 生命周期与撤销

- [INFERRED] 每个 shared viewer/session 注册 revoke channel；Zephyr 在 grant revoke、owner delete、user suspend、device revoke、Token reset 时推送 terminate。
- [KNOWN] push 只是加速；每个操作仍在主端实时授权，不能依赖“没收到 revoke 所以继续用”。
- [INFERRED] One 收到 revoke 后：停止输入/stream、销毁 session key/arena、清 shared UI state、退出 viewer，并只留下不含资源内容的本次安全事件。
- [INFERRED] App 切后台：shared note/AI page 立即遮挡；短 grace 后清；direct terminal 是否保持由 owner policy 决定，但 secret arena 只保留协议 core 仍需要的最小 session key，非握手密码。
- [KNOWN] 账号解绑、切换 server、App Lock 触发、设备撤销必须清空所有 shared in-memory session，无 shared 数据迁移到新账号。

## 8. 审计、错误和 UX

- [KNOWN] shared row 明确显示“来自 <owner> · 在线使用 · 不保存到此设备”；离线时不展示旧内容，给出重新连接动作。
- [KNOWN] direct 模式显示“连接材料仅本次会话送达设备，不会保存”；relay 显示“凭据保留在主端”。不能把两者混成同一句安全承诺。
- [INFERRED] 稳定错误：`shared_online_required`、`shared_grant_expired`、`shared_grant_revoked`、`shared_residency_violation`、`shared_direct_forbidden`、`shared_session_expired`、`shared_session_consumed`、`shared_relay_unavailable`、`shared_content_export_forbidden`。
- [KNOWN] 审计记录 access/use/edit/AI invoke/export/relay/direct mode、device、结果和 byte count；不记录正文、终端输出、frame、文件内容或 secret。

## 9. 测试和发布门

1. [KNOWN] 构造 shared Connection/Note/ACL 后跑 bootstrap/changes，本地实体页必须为零；owner entity 仍正常同步。
2. [KNOWN] 服务端故意注入 owner 不匹配实体，One apply 拒绝且 cursor 不推进。
3. [KNOWN] grep/SQL/FTS/KeyStore/Keychain/preferences/files/log/crash/backup/notification/clipboard 检查均找不到 shared canary。
4. [KNOWN] direct envelope 错 device/session/resource/revision/purpose/nonce/expiry 全部解密或消费失败；重复消费失败。
5. [KNOWN] native arena 在 connect success/failure/cancel/revoke/background/memory warning 路径都执行销毁；instrumented allocator 检查已知 buffer 清零，同时文档承认第三方/OS copy 不能绝对证明。
6. [KNOWN] relay 模式抓包/客户端 hook 不出现 password/private key/provider key/env value/client token；主端 revoke 立即断流。
7. [KNOWN] shared note 离线不可读、进程重启不可恢复、编辑冲突不生成 owned copy。
8. [KNOWN] AI 主端执行 shared tool，One 只收到脱敏 trace/result；catalog parity 不因此删 tool。
9. [KNOWN] 用户主动下载/复制/export 必须有明确 action、capability、owner policy 和审计；没有后台自动外流。

任一 shared-to-me 资源进入 One 镜像、shared secret 进入持久存储、AI Provider/Env/Client Token 下发、ACL 撤销后仍可从缓存使用、或将 direct 模式虚假描述为“秘密未到设备”，均为发布阻断。
