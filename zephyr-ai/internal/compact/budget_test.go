package compact

import (
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestModelWindowTokens(t *testing.T) {
	if got := ModelWindowTokens("claude-3-7-sonnet", 0); got != 200000 {
		t.Fatalf("claude window %d", got)
	}
	if got := ModelWindowTokens("gemini-2.5-pro", 0); got != 1000000 {
		t.Fatalf("gemini window %d", got)
	}
	if got := ModelWindowTokens("gpt-4", 0); got != 8192 {
		t.Fatalf("gpt-4 window %d", got)
	}
	if got := ModelWindowTokens("anything", 64000); got != 64000 {
		t.Fatalf("explicit window %d", got)
	}
}

func TestComputeBudgetAccountsForSystemToolsAndOutput(t *testing.T) {
	tools := []provider.ToolSchema{{Name: "large_tool", Description: strings.Repeat("tool ", 400), Parameters: []byte(`{"type":"object"}`)}}
	small := ComputeBudget(BudgetInput{Model: "gpt-4", SystemPrompt: strings.Repeat("system ", 600), Tools: tools, OutputReserveTokens: 1024})
	large := ComputeBudget(BudgetInput{Model: "claude-3-7-sonnet", SystemPrompt: "sys", Tools: tools, OutputReserveTokens: 4096})
	if small.HistoryBudgetTokens >= small.WindowTokens {
		t.Fatalf("budget %+v", small)
	}
	if large.MaxChars <= small.MaxChars*10 {
		t.Fatalf("small=%+v large=%+v", small, large)
	}
	cfg := ConfigForBudget(small)
	if cfg.MaxChars != small.MaxChars || cfg.RecentChars <= 0 {
		t.Fatalf("cfg %+v budget %+v", cfg, small)
	}
}

func TestEstimateTextTokensCountsCJKMoreDensely(t *testing.T) {
	latin := EstimateTextTokens("abcd")
	cjk := EstimateTextTokens("中文测试")
	if cjk <= latin {
		t.Fatalf("latin=%d cjk=%d", latin, cjk)
	}
}
