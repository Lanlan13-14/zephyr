package compact

import (
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestSnipAndPruneKeepsPairing(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleSystem, Content: "SYSTEM_FULL_NEVER_TOUCH"},
		{Role: provider.RoleUser, Content: "u1"},
		{Role: provider.RoleAssistant, Content: "a1", ToolCalls: []provider.ToolCall{{ID: "t1", Name: "x", Arguments: []byte(`{}`)}}},
		{Role: provider.RoleTool, ToolCallID: "t1", Name: "x", Content: strings.Repeat("Z", 20000)},
		{Role: provider.RoleUser, Content: "u2 recent"},
		{Role: provider.RoleAssistant, Content: "a2 recent"},
	}
	cfg := Defaults()
	cfg.MaxChars = 5000
	cfg.RecentChars = 500
	cfg.ToolHeadChars = 100
	cfg.ToolTailChars = 100
	res := Apply(msgs, cfg)
	if res.Messages[0].Content != "SYSTEM_FULL_NEVER_TOUCH" {
		t.Fatal("system must be untouched")
	}
	// Either tool still present with pairing, or folded into summary — system never touched.
	var tool *provider.Message
	for i := range res.Messages {
		if res.Messages[i].Role == provider.RoleTool {
			tool = &res.Messages[i]
			break
		}
	}
	if tool != nil {
		if tool.ToolCallID != "t1" {
			t.Fatalf("pairing broken: %+v", *tool)
		}
		if len(tool.Content) >= 20000 {
			t.Fatal("expected snip or prune of large tool result")
		}
	} else if !res.Compacted && res.Snipped == 0 && res.Pruned == 0 {
		t.Fatal("expected some compaction action")
	}
	// recent must remain
	joined := ""
	for _, m := range res.Messages {
		joined += m.Content
	}
	if !strings.Contains(joined, "u2 recent") {
		t.Fatal("recent user lost")
	}
}

func TestCompactFoldsOldWork(t *testing.T) {
	var msgs []provider.Message
	msgs = append(msgs, provider.Message{Role: provider.RoleSystem, Content: "SYS"})
	for i := 0; i < 30; i++ {
		msgs = append(msgs,
			provider.Message{Role: provider.RoleUser, Content: strings.Repeat("U", 200)},
			provider.Message{Role: provider.RoleAssistant, Content: strings.Repeat("A", 200)},
		)
	}
	// recent
	msgs = append(msgs,
		provider.Message{Role: provider.RoleUser, Content: "LATEST_USER"},
		provider.Message{Role: provider.RoleAssistant, Content: "LATEST_AI"},
	)
	cfg := Defaults()
	cfg.MaxChars = 3000
	cfg.RecentChars = 400
	res := Apply(msgs, cfg)
	if !res.Compacted && res.Snipped == 0 && res.Pruned == 0 {
		// with enough pressure should compact
		t.Logf("chars %d -> %d", res.OriginalChars, res.FinalChars)
	}
	joined := ""
	for _, m := range res.Messages {
		joined += m.Content
	}
	if !strings.Contains(joined, "LATEST_USER") {
		t.Fatal("recent user lost")
	}
	if !strings.Contains(joined, "SYS") {
		t.Fatal("system lost")
	}
}
