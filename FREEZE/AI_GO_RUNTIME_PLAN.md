# Zephyr AI Go Runtime 改造方案

> 决策日期：2026-07-20  
> 状态：Stage A 完成（2026-07-20）；Stage B compaction 已接入 agent loop

## 决策（已拍板）

1. **SSE** 作为流式传输（Node 代理 cookie 会话 → Go ticket）。
2. **服务端会话权威**（SQLite in zephyr-ai）。
3. **权限模式** ask / auto / yolo + deny/ask/allow 规则（plan/goal 正交）。
4. **MCP** 一等公民（stdio + HTTP），工具名 `mcp__server__tool`。
5. **禁止**为省 token 改 system prompt 拼装（compose 必须与 Node `buildSystemPrompt` 同构：全文 skills + memories + env + 时间 + context）。
6. **后端用 Go** 做 AI 数据面；Node 保留控制面与平台工具 Host。

## 进程边界

| 组件 | 职责 |
|------|------|
| `zephyr-ai` (Go) | session/run/event/agent loop/provider/permission/MCP/quota |
| Node `ai-runtime-bridge.js` | 鉴权、解析 Provider 密钥、拼 systemCompose、签发 run |
| Node `/internal/ai-host/v1/*` | 执行 list/remote/notes/browser/ui 等平台工具（ACL 在此） |
| Browser | `/api/ai/runtime/*` + SSE；永不持有 API Key |

## 目录

```
zephyr-ai/
  cmd/zephyr-ai/
  internal/
    agent/       # multi-step loop + parallel readonly tools
    compose/     # system prompt assembly (NO token thinning)
    config/
    event/       # SSE protocol v1
    mcp/
    permission/
    provider/    # openai|anthropic|gemini|ollama
    server/      # admin + SSE HTTP
    session/     # sqlite sessions/messages/runs/events/quota/grants
    tool/        # registry + platform host client
```

## 阶段

### Stage A — 底座（完成）

- [x] Go module + provider registry（OpenAI stream SSE / Anthropic / Gemini）
- [x] Session store + quota + grants + resume_json
- [x] Agent loop + events + permission engine
- [x] **真 mid-run permission/capture resume**（ResumeState + 不注入假 user turn）
- [x] MCP client (stdio/http)
- [x] Platform host RPC client + Node host routes
- [x] Node bridge + `/api/ai/runtime/*` + SSE proxy
- [x] Legacy `/api/ai/chat` 保留
- [x] compose 禁止砍 skill/memory
- [x] 前端 AI 面板 SSE + 气泡 DOM 对齐
- [x] MCP 管理 UI（设置 → AI）
- [x] Docker entrypoint 同容器启动 zephyr-ai + Node
- [x] unit tests (go) + bridge contract + go smoke (node)

### Stage B — 上下文 compaction（对话历史，不碰 system 拼装）

- [x] 分层 snip/prune/summary（`internal/compact`，agent loop 默认启用）
- [x] archive 落盘 + `history_search` / `history_get` 工具回查
- 仍禁止把 skills 改成索引-only

### Stage C — 权限 UX + Plan/Goal 模式

- [x] Plan/Goal 模式 UI（AI 面板 `aiCollabMode`）+ 服务端工具过滤 / 模式后缀
- [x] 权限规则编辑器（设置 → AI：mode/deny/allow/ask）

### Stage D — 运维工具包增强

- [x] 远程写前快照 + `remote_file_rollback` / `remote_file_snapshot_list`

### Stage E — 子代理（未做）

- [ ] 只读调研子代理 / fleet

## 环境变量

```bash
# Go
ZEPHYR_AI_LISTEN=127.0.0.1:8450
ZEPHYR_AI_ADMIN_TOKEN=...
ZEPHYR_AI_DATA=./data/zephyr-ai
ZEPHYR_AI_PLATFORM_HOST_URL=http://127.0.0.1:PORT
ZEPHYR_AI_PLATFORM_HOST_TOKEN=...

# Node
ZEPHYR_AI_URL=http://127.0.0.1:8450
ZEPHYR_AI_ADMIN_TOKEN=...
ZEPHYR_AI_PLATFORM_HOST_TOKEN=...
```

未设置 `ZEPHYR_AI_URL` 时：runtime API 返回 503，**旧 chat 路径仍可用**。

## 验收门禁

```bash
cd zephyr-ai && go test ./...
node --test tests/ai-runtime-bridge-contract.test.mjs tests/ai-policy.test.mjs
# 启用 runtime 后：
# curl healthz; create session; start run; SSE 收到 run.started → text.delta → run.completed
```
