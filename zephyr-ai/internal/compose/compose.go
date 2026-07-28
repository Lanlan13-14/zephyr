// Package compose builds the model-facing prompt.
//
// HARD CONSTRAINT:
// Do NOT thin skills/guidance/memories/env to save tokens.
// Variable blocks (time/context/routing) MUST leave the stable prefix (S1).
//
//	StablePrefix  = identity + language + guidance + custom + skills + memories + env
//	VolatileTail  = current time + zephyr context + routing/goal hints
//
// Compaction may still operate on conversation history (messages), never on
// stripping the standing stable assembly for cost reasons.
package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Skill mirrors Zephyr AI skill records.
type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
	Enabled     bool   `json:"enabled"`
}

// Memory is a standing memory item eligible for prompt injection.
type Memory struct {
	Title   string   `json:"title"`
	Content string   `json:"content"`
	Scope   string   `json:"scope"`
	Project string   `json:"project"`
	Tags    []string `json:"tags"`
}

// EnvVar exposed to the model (visibility already filtered by control plane).
type EnvVar struct {
	Name             string `json:"name"`
	Description      string `json:"description"`
	Value            string `json:"value"`
	ValueVisibleToAI bool   `json:"valueVisibleToAi"`
}

// Input is everything needed to build the system prompt. Match Node behavior.
type Input struct {
	AssistantName       string
	DefaultSystemPrompt string
	CustomSystemPrompt  string
	ContextText         string // pre-formatted Zephyr context block (volatile)
	Locale              string
	Skills              []Skill
	Memories            []Memory // already ranked/selected by caller
	EnvVars             []EnvVar
	// RoutingHint / GoalContract ride the volatile tail (per turn).
	RoutingHint  string `json:"routingHint,omitempty"`
	GoalContract string `json:"goalContract,omitempty"`
	// Now overrides clock for tests; zero → time.Now(). Volatile only.
	Now time.Time
}

// Result is the split assembly used by the agent loop / server.
type Result struct {
	// Stable is the cache-stable system prefix (no wall clock / live context).
	Stable string
	// Volatile is the per-turn context block (time + surface + routing).
	Volatile string
	// StableHash is sha256 hex of Stable (for diagnostics / session freeze).
	StableHash string
	// Full is Stable + "\n\n" + Volatile for legacy single-system callers.
	Full string
}

// SystemPrompt builds the standing system message (stable + volatile joined).
// Prefer Build() for cache-aware runs.
func SystemPrompt(in Input) string {
	return Build(in).Full
}

// Build returns cache-stable prefix and volatile tail separately.
func Build(in Input) Result {
	stable := StablePrefix(in)
	volatile := VolatileTail(in)
	full := stable
	if strings.TrimSpace(volatile) != "" {
		if full != "" {
			full += "\n\n"
		}
		full += volatile
	}
	return Result{
		Stable:     stable,
		Volatile:   volatile,
		StableHash: HashText(stable),
		Full:       strings.TrimRight(full, "\n"),
	}
}

// StablePrefix is frozen across turns until skills/guidance/memories/env/mode change.
func StablePrefix(in Input) string {
	name := strings.TrimSpace(in.AssistantName)
	if name == "" {
		name = "Zephyr AI 助理"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "你是 %s，运行在 Zephyr SSH 管理平台内。\n", name)
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(in.Locale)), "en") {
		b.WriteString("Response language: English. Reply in concise, direct English unless the user explicitly requests another language.\n")
	} else {
		b.WriteString("回复语言：简体中文。除非用户明确要求其他语言，否则使用简洁、直接的中文。\n")
	}

	if d := strings.TrimSpace(in.DefaultSystemPrompt); d != "" {
		b.WriteString(d)
		b.WriteByte('\n')
	}

	if custom := strings.TrimSpace(in.CustomSystemPrompt); custom != "" {
		b.WriteString("\n用户自定义系统提示：\n")
		b.WriteString(custom)
		b.WriteByte('\n')
	}

	// Full skill bodies — not name-only indexes (token-saving forbidden here).
	// Sort by id for byte-stable order across runs.
	enabled := make([]Skill, 0, len(in.Skills))
	for _, s := range in.Skills {
		if s.Enabled && (strings.TrimSpace(s.Prompt) != "" || strings.TrimSpace(s.Description) != "" || strings.TrimSpace(s.Name) != "") {
			enabled = append(enabled, s)
		}
	}
	sort.SliceStable(enabled, func(i, j int) bool {
		ai, aj := strings.TrimSpace(enabled[i].ID), strings.TrimSpace(enabled[j].ID)
		if ai == "" {
			ai = enabled[i].Name
		}
		if aj == "" {
			aj = enabled[j].Name
		}
		return ai < aj
	})
	if len(enabled) > 0 {
		b.WriteString("\n已启用 Skills：\n")
		for i, s := range enabled {
			fmt.Fprintf(&b, "# Skill %d: %s\n", i+1, orDefault(s.Name, "未命名"))
			if strings.TrimSpace(s.Description) != "" {
				fmt.Fprintf(&b, "说明：%s\n", s.Description)
			}
			if strings.TrimSpace(s.Prompt) != "" {
				b.WriteString(s.Prompt)
				b.WriteByte('\n')
			}
			if i != len(enabled)-1 {
				b.WriteByte('\n')
			}
		}
	}

	if len(in.Memories) > 0 {
		b.WriteString("\n长期 Memory / 项目记忆（已按当前连接、项目、标签自动关联；按需参考，不要泄露敏感信息）：\n")
		for _, m := range in.Memories {
			label := strings.TrimSpace(m.Title)
			if label == "" {
				label = "Memory"
			}
			fmt.Fprintf(&b, "- %s: %s\n", label, m.Content)
		}
	}

	if len(in.EnvVars) > 0 {
		b.WriteString("\n可用 AI 环境变量（仅列出允许暴露给 AI 的条目）：\n")
		for _, e := range in.EnvVars {
			if strings.TrimSpace(e.Name) == "" {
				continue
			}
			desc := ""
			if strings.TrimSpace(e.Description) != "" {
				desc = " — " + e.Description
			}
			val := "（值需通过 get_env_var 并经敏感确认读取）"
			if e.ValueVisibleToAI && e.Value != "" {
				v := e.Value
				if len(v) > 4000 {
					v = v[:4000]
				}
				val = " = " + v
			}
			fmt.Fprintf(&b, "- %s%s%s\n", e.Name, desc, val)
		}
	}

	return strings.TrimRight(b.String(), "\n")
}

// VolatileTail changes every turn (time, live surface context, routing).
func VolatileTail(in Input) string {
	now := in.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	var b strings.Builder
	b.WriteString("<zephyr-context>\n")
	fmt.Fprintf(&b, "当前时间：%s\n", now.Format(time.RFC3339))
	if ctx := strings.TrimSpace(in.ContextText); ctx != "" {
		b.WriteString(ctx)
		if !strings.HasSuffix(ctx, "\n") {
			b.WriteByte('\n')
		}
	}
	b.WriteString("</zephyr-context>")
	if hint := strings.TrimSpace(in.RoutingHint); hint != "" {
		b.WriteString("\n\n<routing-hint>\n")
		b.WriteString(hint)
		b.WriteString("\n</routing-hint>")
	}
	if goal := strings.TrimSpace(in.GoalContract); goal != "" {
		b.WriteString("\n\n<goal-contract>\n")
		b.WriteString(goal)
		b.WriteString("\n</goal-contract>")
	}
	return strings.TrimRight(b.String(), "\n")
}

// HashText returns sha256 hex of text for prefix diagnostics.
func HashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// HashTools returns a stable hash of tool schemas (name-sorted, raw params).
func HashTools(namesAndParams []string) string {
	sorted := append([]string(nil), namesAndParams...)
	sort.Strings(sorted)
	return HashText(strings.Join(sorted, "\n"))
}

func orDefault(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}
