# zephyr-ai

Go AI data plane for Zephyr SSH.

Node remains the **control plane** (auth, ACL, provider secrets, platform tools).
This process owns **sessions, agent loop, SSE events, permissions, MCP, quota**.

## Architecture

```
Browser ──cookie──▶ Node (/api/ai/runtime/*)
                       │ admin token + provider secret
                       ▼
                    zephyr-ai  ──SSE──▶ Browser (via Node proxy)
                       │
                       │ platform host RPC
                       ▼
                    Node /internal/ai-host/v1/*  (SSH/notes/browser/UI tools)
```

## Run

```bash
export ZEPHYR_AI_LISTEN=127.0.0.1:8450
export ZEPHYR_AI_ADMIN_TOKEN=dev-token
export ZEPHYR_AI_DATA=./data/zephyr-ai
export ZEPHYR_AI_PLATFORM_HOST_URL=http://127.0.0.1:3000   # Node
export ZEPHYR_AI_PLATFORM_HOST_TOKEN=dev-token

go run ./cmd/zephyr-ai
```

Node env:

```bash
export ZEPHYR_AI_URL=http://127.0.0.1:8450
export ZEPHYR_AI_ADMIN_TOKEN=dev-token
export ZEPHYR_AI_PLATFORM_HOST_TOKEN=dev-token
```

## Hard constraints

1. **Do not thin system prompt assembly for tokens.** `internal/compose` mirrors
   Node `buildSystemPrompt` (full skills + memories + env + timestamp + context).
2. Provider API keys never go to the browser.
3. Event protocol versioned (`event.ProtocolVersion`); bump on breaking changes.
4. Platform tools execute on Node via versioned host RPC (`v1`).

## Tests

```bash
go test ./...
```

## API (admin)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/sessions` | create session |
| GET | `/admin/sessions?userId=` | list |
| POST | `/admin/runs` | start run (returns ticket + sse path) |
| GET | `/v1/runs/{id}/events?ticket=` | SSE stream |
| POST | `/admin/runs/{id}/abort` | cancel |
| POST | `/admin/mcp/connect` | attach MCP server |

Browser should use Node routes under `/api/ai/runtime/*` (cookie auth + SSE proxy).
