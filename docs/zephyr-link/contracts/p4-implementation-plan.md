# P4 实施合同（先恢复证明，再多写 —— 本轮只做「先」）

规范 §13 P4：WebDAV v2 备份恢复 → 多写 OpLog；撤销与 key epoch。  
§6.1：**先**独立密码 E2EE 备份、校验、完整恢复、代际保留；**后**多设备 OpLog。  
测试 §6.4：独立密码在新设备上可完整恢复连接、密钥、笔记；错误密码/篡改密文失败关闭；**缺强条件写时只能 B0/B1，不得开放多写者。**

基线：`fe3bfe3fb14ca44517d379d84ad660f04e2b9398`（P3）。
备份：`/var/minis/workspace/backups/zephyr-link-foundation-v1-before-p4-20261028-231500.bundle`。

**禁止宣称：** B2 多写 OpLog；主端↔Vault 自动互写；密钥轮换让已泄漏密文作废；wipe 即时物理自毁；L5–L8 真机。

**禁止：** git commit/push；截断 `server.js`；改规范正文；把现有 `WEBDAV_BACKUP_KEY` 单文件备份改名为多端同步。

## 现状（已核实）

- `webdav-backup-provider.js`：AES-256-GCM 用 **服务端** `WEBDAV_BACKUP_KEY`。`verifyBackup` 只解密校验，**不恢复**。
- `webdav-sync-service.js`：`syncNow` 只上传，没有 `download`/`restore` HTTP。
- `backup-encryption.js`：已有 **scrypt + AES-256-GCM** 独立密码信封（主端 `/api/data` 备份）。P4 复用它包一层 vault 密文，**不要**新造第三套密码学。
- `webdav-writer-grade.js`：B0/B1/B2 分级已在。本轮 restore 是 B0/B1。
- 现有 v1 备份继续可用。独立密码 vault 是 **additive**。

## 文件所有权

| 组 | 可改 |
|---|---|
| A 密码信封 + 打开 | 新建 `webdav-vault-password.js`、`tests/webdav-vault-password.test.mjs`。可 **只读** require `backup-encryption.js`。禁止改 backup-encryption 行为。 |
| B 下载恢复 | `webdav-backup-provider.js`（增加 `openBackup` 解 zip+payload，不写业务库）、`webdav-sync-service.js`（`downloadBackup` GET 远端文件）、新建 `webdav-vault-restore.js`（把 payload.collections 写入 ResourceService/NotesService）。`webdav-sync-routes.js` 增加 `POST /restore`（body `{ vaultPassword }`，不把密码记日志）。测试：`tests/webdav-vault-restore.test.mjs`、追加 `tests/webdav-sync-service.test.mjs`。`server.js` **只**把 restore 接到已有 router 挂载处，禁止其它改动。 |
| C 分级守门 + 代际 | `webdav-writer-grade.js`（若缺 B1 单 writer 探测可补）、`webdav-sync-service.js` **仅** `syncNow` 开头：若探测到非 B2，拒绝任何「第二 writer」路径（本轮没有第二 writer 代码则加断言+测试：`classifyWebdavWriter` 为 B0 时 `syncNow` 仍允许 **单写者备份**；若将来 flags `multiWriter:true` 必须 throw）。新建测试证明 **没有** oplog 目录被创建。不要实现 `/oplog/`。 |

C 与 B 都可能改 `webdav-sync-service.js`：C 只在 `syncNow`/`_syncNow` 开头加 grade 检查；B 只 **追加** `downloadBackup`/`restoreFromRemote` 方法。禁止互相重写整文件。

## A — 独立密码包裹（不依赖 WEBDAV_BACKUP_KEY 才能恢复）

目标：攻击者拿到远端 `zephyr-backup.bin` 但没有用户 vault 密码，解不开。新设备只要 URL+密码就能打开。服务端 `WEBDAV_BACKUP_KEY` **不得**作为恢复必要条件（规范：主端不可用时仍可凭 vault 地址和独立密码恢复）。

设计（固定，勿另发明）：

```
inner = 现有 provider 产出的 AES-GCM archive body（仍可用 WEBDAV_BACKUP_KEY，兼容旧路径）
outer = backup-encryption.encryptBackup(inner, vaultPassword)
远端存储 outer
```

- wrap：`wrapVaultArchive(innerBuffer, vaultPassword) → outerBuffer` 调用 `encryptBackup`。
- unwrap：`unwrapVaultArchive(outerBuffer, vaultPassword) → innerBuffer` 调用 `decryptBackup`。错密码 → `backup_authentication_failed` 映射为 `webdav_vault_password_invalid`，**不要**区分「错密码 vs 篡改」给攻击者（可同一 public code）。
- 探测：若 body 以 `backup-encryption.CURRENT_MAGIC` 开头则走 unwrap；否则当现行 inner（无密码的旧备份）。这样旧 `WEBDAV_BACKUP_KEY` 备份仍 `verifyBackup`。
- 密码最低强度：复用 `requireStrongBackupSecret`（已有）。弱密码拒绝 wrap。
- **不得**把 vault 密码写入 DB、日志、activity。

测试：

- wrap/unwrap roundtrip 字节相等
- 错密码失败，不返回 inner
- 翻 1 字节密文失败
- 旧 inner（无 CURRENT_MAGIC）detect 为 unwrapped
- 弱密码拒绝

跑：`node --test tests/webdav-vault-password.test.mjs`

## B — 下载 + 完整恢复

1. `verifyBackup` 保持。新增 `openBackup(body, {backupKey, instanceId, userId})`：verify 后 unzip `user-data.json`，返回 `{ header, payload }`。payload.collections 含 connections/notes/sshKeys 等。

2. `WebDavSyncService.downloadBackup(userId)`：GET 远端 `BACKUP_FILE`，返回 `{ body, etag }`。不解密。

3. `restoreFromRemote(userId, { vaultPassword, backupKey? })`：
   - download
   - 若 outer magic → unwrap(vaultPassword)；否则 inner=body
   - openBackup(inner)
   - `applyUserSnapshot(payload, { resourceService, notesService, user })`：
     - connections/proxies/sshKeys/jumpHosts/notes 按 id upsert（已存在则 update，remoteMerge 以免 Desktop outbox 把恢复当本地新编辑狂传——恢复应 `remoteMerge: true`）
     - 不恢复 auth/sessions/webdav 配置/主密钥
     - 错误密码在 apply **之前**失败，canonical 无新行
   - 整笔尽量一个 sqlite transaction（notes+resources 同 db）

4. 路由 `POST /restore` body `{ vaultPassword }`，sensitiveVerification 已有则套上。响应 `{ ok, restored: { connections, notes, ... counts } }` 无密码、无明文密钥。

5. 测试用内存 DAV（照抄 `tests/webdav-sync-service.test.mjs` fake HTTP）：
   - 备份含 1 connection + 1 note（含 secret 字段）→ wrap 密码 → upload（可直接 put body）→ 新空库 restore → 行回来且 password 正确
   - 错密码：0 行
   - 无 WEBDAV_BACKUP_KEY 但有密码+outer：仍能 unwrap 到 inner **仅当 inner 不是 WEBDAV_BACKUP_KEY 加密**。  
     **重要：** 现有 inner 仍用 WEBDAV_BACKUP_KEY。要满足「不依赖主端环境密钥」：wrap 的 plaintext 必须是 **未再被 WEBDAV_BACKUP_KEY 包的 zip**，或 wrap 里同时用密码派生的密钥直接加密 zip。  
     **更正 A/B 边界：**  
     `wrapVaultArchive` 的 plaintext = **zip archive bytes**（verifyBackup 返回的 `archive`），不是再包一层 WEBDAV_BACKUP_KEY inner。  
     生产 `syncNow`：若用户配置了 vaultPassword（config 新字段 `hasVaultPassword`，密码用现有 credential crypto 存 `vault_password_enc`，与 WebDAV 登录密码分开），则远端上传 `encryptBackup(zip, vaultPassword)`；否则保持今天的 WEBDAV_BACKUP_KEY inner（兼容）。  
     restore 新设备：只需 vaultPassword + 远端文件，调用 `decryptBackup` 得到 zip，再 unzip payload。**不需要 WEBDAV_BACKUP_KEY。**

config 加法：`webdav_sync_configs.vault_password_enc TEXT` ALTER additive。patchConfig 接受 `vaultPassword`。getConfig 只返回 `hasVaultPassword` boolean。

测试必须覆盖「restore 不读取 process.env.WEBDAV_BACKUP_KEY」。

跑：`node --test tests/webdav-vault-restore.test.mjs tests/webdav-sync-service.test.mjs tests/webdav-backup-provider.test.mjs`

## C — 禁止本轮多写；探测仍诚实

- `syncNow` 不得创建 `oplog/` 或 `generations/`。测试：fake DAV 记录 PUT 路径，全部在用户 namespace 下的 `zephyr-backup.bin` 或 tmp。
- 若 `patchConfig({ multiWriter: true })` → 400 `webdav_multiwriter_requires_B2`。
- `classifyWebdavWriter` 现有测试必须继续绿。
- 不要改 B2 判定放宽。

跑：`node --test tests/webdav-writer-grade.test.mjs` + 新断言文件。

## 明确未做

- B2 双 writer CAS 真 WebDAV
- 密钥轮换作废旧密文
- 主端 wipe 离线设备（可另开，非本轮恢复证明）
- Go `zephyr-link/internal/sync/webdav/` 重写

## 完成后交回

diff --stat、restore 是否不需要 WEBDAV_BACKUP_KEY、测试计数、未做 B2 的声明。不要 commit。
