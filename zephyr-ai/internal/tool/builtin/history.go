package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/archive"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

// HistoryDeps are bound per-run.
type HistoryDeps struct {
	Archive   *archive.Store
	UserID    string
	SessionID string
}

// RegisterHistoryTools adds history_search and history_get.
func RegisterHistoryTools(reg *tool.Registry, deps *HistoryDeps) error {
	if deps == nil || deps.Archive == nil {
		return nil
	}
	searchSchema := json.RawMessage(`{
		"type":"object",
		"properties":{
			"query":{"type":"string","description":"Search terms for archived conversation / tool output"},
			"scope":{"type":"string","enum":["session","user"],"description":"session=current chat only; user=all sessions"},
			"limit":{"type":"number"}
		},
		"required":["query"]
	}`)
	getSchema := json.RawMessage(`{
		"type":"object",
		"properties":{
			"id":{"type":"string","description":"Archive entry id from history_search"},
			"operation":{"type":"string","enum":["get","around"],"description":"get full entry or around window"}
		},
		"required":["id"]
	}`)

	if err := reg.Register(&tool.FuncTool{
		ToolName:        "history_search",
		ToolDescription: "Search archived (compacted) conversation fragments and tool outputs. Use when earlier tool results were snipped/pruned/summarized. Returns ids + snippets; then history_get for full text.",
		ToolSchema:      searchSchema,
		IsReadOnly:      true,
		IsParallelSafe:  true,
		ToolRisk:        tool.RiskLow,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Query string `json:"query"`
				Scope string `json:"scope"`
				Limit int    `json:"limit"`
			}
			_ = json.Unmarshal(args, &a)
			if a.Query == "" {
				return nil, fmt.Errorf("query required")
			}
			hits, err := deps.Archive.Search(deps.UserID, deps.SessionID, a.Query, a.Scope, a.Limit)
			if err != nil {
				return nil, err
			}
			out := make([]map[string]any, 0, len(hits))
			for _, h := range hits {
				out = append(out, map[string]any{
					"id":        h.ID,
					"kind":      h.Kind,
					"role":      h.Role,
					"name":      h.Name,
					"score":     h.Score,
					"snippet":   h.Snippet,
					"sessionId": h.SessionID,
					"createdAt": h.CreatedAt,
					"toolCallId": h.ToolCallID,
				})
			}
			hint := ""
			if len(out) == 0 {
				hint = "0 hits — try rarer terms or scope=user"
			}
			return map[string]any{"hits": out, "count": len(out), "hint": hint}, nil
		},
	}); err != nil {
		return err
	}

	return reg.Register(&tool.FuncTool{
		ToolName:        "history_get",
		ToolDescription: "Read full archived entry by id from history_search. operation=around returns nearby entries in the same session.",
		ToolSchema:      getSchema,
		IsReadOnly:      true,
		IsParallelSafe:  true,
		ToolRisk:        tool.RiskLow,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				ID        string `json:"id"`
				Operation string `json:"operation"`
			}
			_ = json.Unmarshal(args, &a)
			if a.ID == "" {
				return nil, fmt.Errorf("id required")
			}
			e, err := deps.Archive.Get(deps.UserID, a.ID)
			if err != nil {
				return nil, err
			}
			if a.Operation == "around" {
				near, err := deps.Archive.Around(deps.UserID, e.SessionID, e.CreatedAt, 5)
				if err != nil {
					return nil, err
				}
				list := make([]map[string]any, 0, len(near))
				for _, n := range near {
					c := n.Content
					if utf8.RuneCountInString(c) > 4000 {
						c = string([]rune(c)[:4000]) + "…"
					}
					list = append(list, map[string]any{
						"id": n.ID, "kind": n.Kind, "role": n.Role, "name": n.Name,
						"content": c, "createdAt": n.CreatedAt,
					})
				}
				return map[string]any{"center": e.ID, "entries": list}, nil
			}
			return map[string]any{
				"id": e.ID, "kind": e.Kind, "role": e.Role, "name": e.Name,
				"toolCallId": e.ToolCallID, "content": e.Content,
				"meta": e.MetaJSON, "createdAt": e.CreatedAt, "sessionId": e.SessionID,
			}, nil
		},
	})
}
