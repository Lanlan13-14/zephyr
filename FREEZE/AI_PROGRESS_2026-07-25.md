# Zephyr-SSH AI 全能力改造：实施进度

> 2026-07-25 起步 · 2026-07-26 全覆盖收口 · 当前分支基于 `1319e02`

## 目标

AI 覆盖项目所有非人类专属操作；人类专属操作显式标记 `humanOnly` 并写明原因。
同时满足：接口完整、接口标准、模型能通过 Playbook + `capability_search` 稳定发现/选择/执行/验证。

---

## 能力覆盖一览

| 领域 | 状态 | canonical Tool / 边界 | 风险 |
|---|---|---|---|
| capability-search | ✅ | `capability_search`，同时发现核心与扩展运维能力 | R0 |
| connection | ✅ | `connection_list/get/create/update/rename/delete/test/open_v1` | R0‑R3 |
| proxy | ✅ | `proxy_list/get/create/update/delete_v1` | R0‑R3 |
| ssh-key meta | ✅ | `ssh_key_list/get/validate/rename/update_metadata/delete_v1` | R0‑R1,R3 |
| ssh-key secret | ✅ 边界 | import/generate/reveal → `humanOnly`；已保存密钥可用不透明 `secretRef` 绑定 | R4 |
| jump-host | ✅ | `jump_host_list/get/create/update/delete_v1` + revision/ACL | R0‑R3 |
| snippet | ✅ | `snippet_list/get/create/update/delete_v1`，用户隔离 + revision | R0‑R3 |
| ssh/telnet-ops | ✅ | `terminal_read/send/wait_v1`，服务端权威 scrollback；TELNET 不伪装 SSH exec | R0‑R2 |
| rdp-vnc-ops | ✅ | `remote_desktop_capture/action/verify_v1`，`captureId` + 前后帧闭环 | R0‑R2 |
| browser-ops | ✅ | `browser_inspect/click/type_v1`，`elementRef` + `domRevision` | R0‑R2 |
| agent/device | ✅ | `agent_list/get_v1` + `agent_file_*_v1`；Token 管理 `humanOnly` | R0‑R3,R4 |
| context-mgmt | ✅ | Legacy + Go Runtime 按模型窗口、system/tools、输出预留和安全余量动态预算 | — |
| secret-ref | ✅ | 短期签名、不透明、用户绑定；授权前验证；模型不见秘密/资源 ID | R0/R2/R4 |
| notes/memory/plan/env/web/ui/ssh-files | ✅ | 全部模型可见 Tool 纳入 capability/risk/confirmation/Playbook 门禁 | R0‑R4 |

---

## 新增基础设施

- `ai-jump-host-tools.js` / `ai-snippet-tools.js`：资源标准化、revision 和严格 Schema。
- `ai-terminal-session-tools.js`：SSH/TELNET 服务端权威 read/send/wait。
- `ai-remote-desktop-tools.js`：`captureId`、动作绑定、前后帧验证；RDP Worker 真截图。
- `ai-browser-service.js`：短期 `elementRef`、`domRevision` 与 stale 拒绝。
- `ai-agent-device-tools.js`：Agent 归属、路径边界、文本读取和受控写操作。
- `ai-secret-refs.js`：HMAC 签名的短期不透明引用。
- `ai-context-budget.js` + `zephyr-ai/internal/compact/budget.go`：模型窗口动态上下文预算。
- `ai-extended-capabilities.js` / `ai-operations-playbooks.js`：旧运维 Tool 的统一能力、风险、确认和操作规程。
- `tests/ai-full-tool-coverage.test.mjs`：模型目录 fail-closed 全覆盖门禁。

## 安全关键决策

- 模型目录不再暴露可接收 password/privateKey/passphrase/token/apiKey 的旧资产 Tool。
- 所有模型可见 Tool 使用 `additionalProperties:false`；未知字段在执行前拒绝。
- R1‑R4 按 capability 策略统一确认；`confirmedToolId` 精确绑定。
- ACL/资源归属/secretRef/笔记开关检查发生在确认之前，不能给无权操作生成确认卡。
- `secretRef` 不返回秘密；SSH 连接公开视图只返回 `hasSshKey`。
- RDP/VNC 不能把“已请求操作”当成功；必须有新帧并完成 verify。
- 上下文不再按固定消息条数截断。

## 验证门禁

- AI 串行回归：**107/107 passed**。
- Go Runtime：`go test ./...` 通过。
- JavaScript 语法：46 个文件通过。
- 模型 Tool 目录：**76 total / 0 unbound / 0 loose schema**。
- RDP 核心 renderer/worker/input/touch/wasm 定向回归通过。
- 并行拉起多台真实测试服务在 Android PRoot 会产生资源争用；完整服务集成门禁固定使用 `--test-concurrency=1`，覆盖不减少。

## 状态

冻结表中的未完成项已经全部落地。后续工作属于新增能力或优化，不再属于本表欠账。
