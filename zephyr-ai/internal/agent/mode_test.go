package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

func TestFilterToolsForPlan(t *testing.T) {
	reg := tool.NewRegistry()
	_ = reg.Register(&tool.FuncTool{
		ToolName: "list_connections", ToolDescription: "r", ToolSchema: json.RawMessage(`{}`),
		IsReadOnly: true, Fn: func(ctx context.Context, args json.RawMessage) (any, error) { return nil, nil },
	})
	_ = reg.Register(&tool.FuncTool{
		ToolName: "remote_execute", ToolDescription: "w", ToolSchema: json.RawMessage(`{}`),
		IsReadOnly: false, Fn: func(ctx context.Context, args json.RawMessage) (any, error) { return nil, nil },
	})
	_ = reg.Register(&tool.FuncTool{
		ToolName: "plan_task", ToolDescription: "p", ToolSchema: json.RawMessage(`{}`),
		IsReadOnly: false, Fn: func(ctx context.Context, args json.RawMessage) (any, error) { return nil, nil },
	})
	_ = reg.Register(&tool.FuncTool{
		ToolName: "history_search", ToolDescription: "h", ToolSchema: json.RawMessage(`{}`),
		IsReadOnly: true, Fn: func(ctx context.Context, args json.RawMessage) (any, error) { return nil, nil },
	})

	plan := FilterToolsForMode(reg, "plan")
	names := map[string]bool{}
	for _, t := range plan.List() {
		names[t.Name()] = true
	}
	if !names["list_connections"] || !names["plan_task"] || !names["history_search"] {
		t.Fatalf("missing allowed: %v", names)
	}
	if names["remote_execute"] {
		t.Fatal("remote_execute must be blocked in plan mode")
	}

	std := FilterToolsForMode(reg, "standard")
	if len(std.List()) != 4 {
		t.Fatalf("standard should keep all, got %d", len(std.List()))
	}
	if ModeSystemSuffix("plan") == "" || ModeSystemSuffix("goal") == "" {
		t.Fatal("suffixes")
	}
}
