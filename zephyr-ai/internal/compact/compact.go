// Package compact manages conversation history size.
//
// HARD RULE: this package only touches conversation messages (user/assistant/tool).
// It never rewrites or thins the standing system prompt assembly (compose package).
//
// Strategy (tiered, cache-friendly for the recent tail):
//  1. Below SnipRatio: no-op
//  2. >= SnipRatio: shorten old tool results (head+tail) while keeping pairing
//  3. >= PruneRatio: replace old tool results with short placeholders
//  4. >= CompactRatio: fold older assistant/tool work into one summary user note;
//     keep every user turn that fits and the recent tail intact
package compact

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

type Config struct {
	// MaxChars is the soft budget for serialized message text (not tokens).
	MaxChars int
	// Ratios of MaxChars.
	SnipRatio    float64 // default 0.6
	PruneRatio   float64 // default 0.75
	CompactRatio float64 // default 0.85
	// RecentChars protected from rewrite (recent tail).
	RecentChars int
	// Tool result caps after snip.
	ToolHeadChars int
	ToolTailChars int
	// Keep error tool results full when pruning.
	KeepErrors bool
}

func Defaults() Config {
	// S5: Reasonix-aligned tiers (snip 0.6 / prune 0.8 / compact 0.9).
	return Config{
		MaxChars:      180000,
		SnipRatio:     0.60,
		PruneRatio:    0.80,
		CompactRatio:  0.90,
		RecentChars:   42000,
		ToolHeadChars: 2000,
		ToolTailChars: 2000,
		KeepErrors:    true,
	}
}

type Result struct {
	Messages       []provider.Message
	OriginalChars  int
	FinalChars     int
	Snipped        int
	Pruned         int
	Compacted      bool
	DroppedTurns   int
	// Archived holds messages removed/folded so callers can persist them.
	Archived []provider.Message
	// SnippedTools holds tool messages after snip (full original in Archived if set).
	SnipOriginals []provider.Message
}

func totalChars(msgs []provider.Message) int {
	n := 0
	for _, m := range msgs {
		n += utf8.RuneCountInString(m.Content)
		for _, p := range m.Parts {
			n += utf8.RuneCountInString(p.Text)
		}
		for _, tc := range m.ToolCalls {
			n += len(tc.Arguments) + len(tc.Name)
		}
	}
	return n
}

// Apply runs tiered compaction. System messages are preserved as-is at the front.
func Apply(msgs []provider.Message, cfg Config) Result {
	if cfg.MaxChars <= 0 {
		cfg = Defaults()
	}
	if cfg.SnipRatio <= 0 {
		cfg.SnipRatio = 0.6
	}
	if cfg.PruneRatio <= 0 {
		cfg.PruneRatio = 0.8
	}
	if cfg.CompactRatio <= 0 {
		cfg.CompactRatio = 0.9
	}
	if cfg.RecentChars <= 0 {
		cfg.RecentChars = 42000
	}
	if cfg.ToolHeadChars <= 0 {
		cfg.ToolHeadChars = 2000
	}
	if cfg.ToolTailChars <= 0 {
		cfg.ToolTailChars = 2000
	}

	out := make([]provider.Message, len(msgs))
	copy(out, msgs)
	res := Result{Messages: out, OriginalChars: totalChars(out)}

	budget := cfg.MaxChars
	cur := res.OriginalChars
	if cur <= int(float64(budget)*cfg.SnipRatio) {
		res.FinalChars = cur
		return res
	}

	// Split system prefix
	sysEnd := 0
	for sysEnd < len(out) && out[sysEnd].Role == provider.RoleSystem {
		sysEnd++
	}
	body := out[sysEnd:]

	// Identify recent tail by chars from the end
	tailStart := len(body)
	tailChars := 0
	for i := len(body) - 1; i >= 0; i-- {
		c := msgChars(body[i])
		if tailStart < len(body) && tailChars+c > cfg.RecentChars && (len(body)-i) >= 4 {
			break
		}
		tailStart = i
		tailChars += c
	}
	old := body[:tailStart]
	tail := body[tailStart:]

	// Tier 2: snip old tool results
	if cur > int(float64(budget)*cfg.SnipRatio) {
		for i := range old {
			if old[i].Role != provider.RoleTool {
				continue
			}
			if cfg.KeepErrors && isErrorTool(old[i].Content) {
				continue
			}
			snipped, did := snipTool(old[i].Content, cfg.ToolHeadChars, cfg.ToolTailChars)
			if did {
				res.SnipOriginals = append(res.SnipOriginals, old[i])
				old[i].Content = snipped
				res.Snipped++
			}
		}
		cur = totalChars(append(append([]provider.Message{}, out[:sysEnd]...), append(old, tail...)...))
	}

	// Tier 3: prune old tool results to placeholders (keep pairing)
	if cur > int(float64(budget)*cfg.PruneRatio) {
		for i := range old {
			if old[i].Role != provider.RoleTool {
				continue
			}
			if cfg.KeepErrors && isErrorTool(old[i].Content) {
				continue
			}
			if strings.HasPrefix(old[i].Content, "[tool_result_pruned]") {
				continue
			}
			name := old[i].Name
			if name == "" {
				name = "tool"
			}
			old[i].Content = fmt.Sprintf("[tool_result_pruned] %s output archived; call history_search or re-run if needed. id=%s", name, old[i].ToolCallID)
			res.Pruned++
		}
		cur = totalChars(append(append([]provider.Message{}, out[:sysEnd]...), append(old, tail...)...))
	}

	// Tier 4: summary fold of old assistant/tool work; keep user turns
	if cur > int(float64(budget)*cfg.CompactRatio) {
		var userBits []string
		var workBits []string
		for _, m := range old {
			switch m.Role {
			case provider.RoleUser:
				t := strings.TrimSpace(m.Content)
				if t != "" {
					if utf8.RuneCountInString(t) > 400 {
						t = string([]rune(t)[:400]) + "…"
					}
					userBits = append(userBits, "- 用户: "+t)
				}
			case provider.RoleAssistant:
				t := strings.TrimSpace(m.Content)
				if t != "" {
					if utf8.RuneCountInString(t) > 200 {
						t = string([]rune(t)[:200]) + "…"
					}
					workBits = append(workBits, "- 助理: "+t)
				}
				if len(m.ToolCalls) > 0 {
					names := make([]string, 0, len(m.ToolCalls))
					for _, tc := range m.ToolCalls {
						names = append(names, tc.Name)
					}
					workBits = append(workBits, "- 工具调用: "+strings.Join(names, ", "))
				}
			case provider.RoleTool:
				// already pruned/snipped; skip bulk
			}
		}
		summary := "高轮次对话压缩摘要（自动生成；系统提示与 Skills/Memory 装配未改动）：\n"
		if len(userBits) > 0 {
			summary += "用户要点：\n" + strings.Join(userBits, "\n") + "\n"
		}
		if len(workBits) > 0 {
			// cap work lines
			if len(workBits) > 40 {
				workBits = workBits[:40]
			}
			summary += "前期工作：\n" + strings.Join(workBits, "\n") + "\n"
		}
		summary += fmt.Sprintf("（已折叠 %d 条早期消息；最近 %d 条保持原文）", len(old), len(tail))

		// Keep recent tail; ensure it doesn't start with orphan tool message
		for len(tail) > 0 && tail[0].Role == provider.RoleTool {
			// drop orphan tool at boundary (its assistant tool_calls were summarized)
			tail = tail[1:]
			res.DroppedTurns++
		}
		folded := []provider.Message{{
			Role:    provider.RoleUser,
			Content: summary,
		}}
		res.Archived = append(res.Archived, old...)
		body = append(folded, tail...)
		res.Compacted = true
		res.DroppedTurns += len(old)
	} else {
		body = append(old, tail...)
	}

	out = append(append([]provider.Message{}, out[:sysEnd]...), body...)
	res.Messages = out
	res.FinalChars = totalChars(out)
	return res
}

func msgChars(m provider.Message) int {
	n := utf8.RuneCountInString(m.Content)
	for _, p := range m.Parts {
		n += utf8.RuneCountInString(p.Text)
	}
	return n
}

func isErrorTool(content string) bool {
	s := strings.ToLower(content)
	if strings.Contains(s, `"ok":false`) || strings.Contains(s, `"error"`) {
		return true
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(content), &m); err == nil {
		if ok, exists := m["ok"].(bool); exists && !ok {
			return true
		}
		if _, exists := m["error"]; exists {
			return true
		}
	}
	return false
}

func snipTool(content string, head, tail int) (string, bool) {
	r := []rune(content)
	if len(r) <= head+tail+32 {
		return content, false
	}
	return string(r[:head]) + "\n…[tool_result_snipped]…\n" + string(r[len(r)-tail:]), true
}
