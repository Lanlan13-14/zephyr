// Package compose builds the model-facing prompt.
//
// HARD CONSTRAINT (user decision 2026-07-20):
// Do NOT change system prompt assembly to save tokens.
// Keep the same structure as the Node ai-agent-service buildSystemPrompt:
//   assistant intro + default guidance + current time + context + custom
//   prompt + full enabled skills text + related memories + env vars.
// Compaction may still operate on conversation history (messages), never on
// stripping this standing system assembly for cost reasons.
package compose

import (
	"fmt"
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
	Title   string `json:"title"`
	Content string `json:"content"`
	Scope   string `json:"scope"`
	Project string `json:"project"`
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
	ContextText         string // pre-formatted Zephyr context block
	Skills              []Skill
	Memories            []Memory // already ranked/selected by caller
	EnvVars             []EnvVar
	// Now overrides clock for tests; zero → time.Now().
	Now time.Time
}

// SystemPrompt builds the standing system message. DO NOT thin this out.
func SystemPrompt(in Input) string {
	now := in.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	name := strings.TrimSpace(in.AssistantName)
	if name == "" {
		name = "Zephyr AI 助理"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "你是 %s，运行在 Zephyr SSH 管理平台内。\n", name)

	if d := strings.TrimSpace(in.DefaultSystemPrompt); d != "" {
		b.WriteString(d)
		b.WriteByte('\n')
	}

	fmt.Fprintf(&b, "当前时间：%s\n", now.Format(time.RFC3339))

	if ctx := strings.TrimSpace(in.ContextText); ctx != "" {
		b.WriteString(ctx)
		if !strings.HasSuffix(ctx, "\n") {
			b.WriteByte('\n')
		}
	}

	if custom := strings.TrimSpace(in.CustomSystemPrompt); custom != "" {
		b.WriteString("\n用户自定义系统提示：\n")
		b.WriteString(custom)
		b.WriteByte('\n')
	}

	// Full skill bodies — not name-only indexes (token-saving forbidden here).
	var enabled []Skill
	for _, s := range in.Skills {
		if s.Enabled && (strings.TrimSpace(s.Prompt) != "" || strings.TrimSpace(s.Description) != "" || strings.TrimSpace(s.Name) != "") {
			enabled = append(enabled, s)
		}
	}
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

func orDefault(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}
