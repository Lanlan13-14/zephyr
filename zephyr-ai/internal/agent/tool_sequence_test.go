package agent

import (
	"encoding/json"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func toolCall(id, name string) provider.ToolCall {
	return provider.ToolCall{ID: id, Name: name, Arguments: json.RawMessage(`{}`)}
}

func TestRepairToolCallSequenceDropsOrphanAndKeepsRetry(t *testing.T) {
	in := []provider.Message{
		{Role: provider.RoleUser, Content: "描述当前 RDP 画面"},
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{toolCall("call-orphan", "remote_desktop_capture_v1")}},
		{Role: provider.RoleUser, Content: "再试一次"},
	}
	out := repairToolCallSequence(in)
	if len(out) != 2 || out[0].Role != provider.RoleUser || out[1].Content != "再试一次" {
		t.Fatalf("unexpected repaired history: %#v", out)
	}
}

func TestRepairToolCallSequenceKeepsCompleteBatch(t *testing.T) {
	in := []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{toolCall("c1", "a"), toolCall("c2", "b")}},
		{Role: provider.RoleTool, ToolCallID: "c1", Name: "a", Content: `{"ok":true}`},
		{Role: provider.RoleTool, ToolCallID: "c2", Name: "b", Content: `{"ok":true}`},
		{Role: provider.RoleUser, Content: "next"},
	}
	out := repairToolCallSequence(in)
	if len(out) != len(in) {
		t.Fatalf("complete batch changed: %#v", out)
	}
	for i := range in {
		if out[i].Role != in[i].Role || out[i].ToolCallID != in[i].ToolCallID {
			t.Fatalf("message %d changed: %#v", i, out[i])
		}
	}
}

func TestRepairToolCallSequenceDropsPartialBatch(t *testing.T) {
	in := []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{toolCall("c1", "a"), toolCall("c2", "b")}},
		{Role: provider.RoleTool, ToolCallID: "c1", Name: "a", Content: `{"ok":true}`},
		{Role: provider.RoleUser, Content: "retry"},
	}
	out := repairToolCallSequence(in)
	if len(out) != 1 || out[0].Role != provider.RoleUser || out[0].Content != "retry" {
		t.Fatalf("partial batch not removed: %#v", out)
	}
}
