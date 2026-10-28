# P6 实施合同（可证明内核，不是 Handoff/AI/Cell 完成）

规范 §13 P6：Handoff、AI RPC、Cell、HA。工程索引禁止：只注册 KIND.AI / 只画 Smartbar / echo ack 冒充执行。

基线：`f838130`。备份：`/var/minis/workspace/backups/zephyr-link-foundation-v1-before-p6-20261029-001000.bundle`。

**禁止宣称：** 真 PTY/RDP/VNC 跨端接力、真机动画完成即恢复、KindAI echo=执行、Cell 沙箱真机、多副本 HA。不要 git commit/push。不要截断 `server.js` / `public/app.js` / `ai-agent-service.js`。不要改规范正文。

## 文件所有权

| 组 | 可改 |
|---|---|
| A Handoff epoch | 新建 `link-handoff-session.js`、`tests/link-handoff-session.test.mjs`。`server.js` **只**在创建 SSH/Telnet session 对象时加 `sessionEpoch:1`、`ownerDeviceId`（精确插入）。`public/app.js` 点接管可改为调 `POST /api/link/handoff/request` 若路由存在；没有路由则保持现有「协议尚未实现」toast。 |
| B AI idempotency | 新建 `ai-run-idempotency.js`、`tests/ai-run-idempotency.test.mjs`。禁止把 KindAI echo 改成成功执行。可选：Go `node.go` KindAI 对未知 op 返回 `unsupported_operation` 而不是 ok:true（status 仍可 ack）。 |
| C Cell allowlist | 新建 `zephyr-cell/security/command_allowlist.go` + `_test.go`。不改 PRoot 运行时。 |

无真上游会话时 A 的测试用内存 session 表。
