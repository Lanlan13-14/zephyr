package compact

import (
	"encoding/json"
	"math"
	"strings"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

type BudgetInput struct {
	Model               string
	WindowTokens        int
	OutputReserveTokens int
	SystemPrompt        string
	Tools               []provider.ToolSchema
}

type Budget struct {
	WindowTokens        int `json:"windowTokens"`
	SystemTokens        int `json:"systemTokens"`
	ToolTokens          int `json:"toolTokens"`
	OutputReserveTokens int `json:"outputReserveTokens"`
	SafetyReserveTokens int `json:"safetyReserveTokens"`
	HistoryBudgetTokens int `json:"historyBudgetTokens"`
	MaxChars            int `json:"maxChars"`
}

func EstimateTextTokens(text string) int {
	if text == "" {
		return 0
	}
	cjk := 0
	other := 0
	for _, r := range text {
		if (r >= 0x3400 && r <= 0x9fff) || (r >= 0xf900 && r <= 0xfaff) {
			cjk++
		} else {
			other++
		}
	}
	return int(math.Ceil(float64(cjk)*1.05 + float64(other)/3.7))
}

func ModelWindowTokens(model string, explicit int) int {
	if explicit > 0 {
		return clampBudget(explicit, 1024, 2000000)
	}
	name := strings.ToLower(model)
	switch {
	case strings.Contains(name, "gemini-2"), strings.Contains(name, "gemini-1.5"):
		return 1000000
	case strings.Contains(name, "claude-3"), strings.Contains(name, "claude-4"), strings.Contains(name, "claude-sonnet"), strings.Contains(name, "claude-opus"), strings.Contains(name, "claude-haiku"):
		return 200000
	case strings.Contains(name, "gpt-4.1"), strings.Contains(name, "gpt-4o"), strings.Contains(name, "gpt-5"), strings.Contains(name, "o1"), strings.Contains(name, "o3"), strings.Contains(name, "o4"), strings.Contains(name, "deepseek"), strings.Contains(name, "qwen"), strings.Contains(name, "glm-4"), strings.Contains(name, "kimi"), strings.Contains(name, "moonshot"), strings.Contains(name, "llama-3.1"), strings.Contains(name, "llama-3.2"), strings.Contains(name, "llama-3.3"):
		return 128000
	case strings.Contains(name, "gpt-3.5-turbo"):
		return 16385
	case strings.Contains(name, "gpt-4"):
		return 8192
	default:
		return 128000
	}
}

func ComputeBudget(input BudgetInput) Budget {
	window := ModelWindowTokens(input.Model, input.WindowTokens)
	systemTokens := EstimateTextTokens(input.SystemPrompt)
	toolJSON, _ := json.Marshal(input.Tools)
	toolTokens := EstimateTextTokens(string(toolJSON))
	output := input.OutputReserveTokens
	if output <= 0 {
		output = minBudget(8192, int(float64(window)*0.08))
	}
	output = clampBudget(output, 1024, maxBudget(1024, int(float64(window)*0.25)))
	safety := maxBudget(1024, int(float64(window)*0.05))
	overhead := maxBudget(512, int(math.Ceil(float64(systemTokens+toolTokens)*0.04)))
	history := maxBudget(4096, window-systemTokens-toolTokens-output-safety-overhead)
	return Budget{WindowTokens: window, SystemTokens: systemTokens, ToolTokens: toolTokens, OutputReserveTokens: output, SafetyReserveTokens: safety, HistoryBudgetTokens: history, MaxChars: maxBudget(8000, int(float64(history)*2.8))}
}

func ConfigForBudget(b Budget) Config {
	cfg := Defaults()
	cfg.MaxChars = b.MaxChars
	cfg.RecentChars = maxBudget(8000, int(float64(b.MaxChars)*0.35))
	cfg.ToolHeadChars = minBudget(cfg.ToolHeadChars, maxBudget(500, b.MaxChars/20))
	cfg.ToolTailChars = minBudget(cfg.ToolTailChars, maxBudget(500, b.MaxChars/20))
	return cfg
}

func clampBudget(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
func minBudget(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func maxBudget(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Budget helpers intentionally use conservative character/token estimates.
