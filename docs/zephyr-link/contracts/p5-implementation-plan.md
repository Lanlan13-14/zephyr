# P5 实施合同（本轮只做可证明接线，不是 D15 完成）

规范 §13 P5：Link 版本化合同、Agent 独立策略、VFS/端口转发。D15：最终裁决在 Agent 本机，主端不能并集放大。

基线：`c9c5289`。备份：`/var/minis/workspace/backups/zephyr-link-foundation-v1-before-p5-20261028-234500.bundle`。

**禁止宣称：** 系统目录授权真机（SAF/bookmark）、真 agentd 进程、SMB/SFTP/WebDAV 后端、完整 22 个 Offload、Handoff/AI。参考套件绿灯不是生产证据。不要 git commit/push。不要截断大文件。不要改规范正文。

## 文件所有权

| 组 | 可改 |
|---|---|
| A 路径 jail | 新建 `agent-path-jail.js`、`tests/agent-path-jail.test.mjs`。`file-agent-manager.js` 只在 `callAgent`/`callAgentV2` 入口解析 `params.path`/`from`/`to`/`relativePath`。禁止改 policy engine。 |
| B 策略接线 | `file-agent-manager.js`（`authorizeFileOp`）、`link-v2-file-bridge.js`。可新建 `tests/agent-file-policy-gate.test.mjs`。禁止改 path-jail 模块（只 require）。 |
| C 帧+监听 | 新建 `link-frame-validate.js`、`tests/link-frame-validate.test.mjs`；`agent-policy-engine.js` 只补 listenHost `0.0.0.0`/`::` 无 confirmation → `approval_required`（现有 109 向量不得变绿/变红）。`tests` 可追加 `tests/agent-listen-approval.test.mjs`。 |

无 policyContext 时保持现有 `share.readOnly` 行为。
