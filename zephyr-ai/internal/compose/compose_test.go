package compose

import (
	"strings"
	"testing"
	"time"
)

func TestSystemPromptFollowsUILocale(t *testing.T) {
	en := SystemPrompt(Input{AssistantName: "Zephyr", Locale: "en", DefaultSystemPrompt: "rules", Now: time.Unix(0, 0).UTC()})
	if !strings.Contains(en, "Response language: English") {
		t.Fatalf("missing English language instruction: %s", en)
	}
	zh := SystemPrompt(Input{AssistantName: "Zephyr", Locale: "zh-CN", DefaultSystemPrompt: "rules", Now: time.Unix(0, 0).UTC()})
	if !strings.Contains(zh, "回复语言：简体中文") {
		t.Fatalf("missing Chinese language instruction: %s", zh)
	}
}

func TestSystemPromptKeepsFullAssembly(t *testing.T) {
	fixed := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	out := SystemPrompt(Input{
		AssistantName:       "Zephyr AI",
		DefaultSystemPrompt: "DEFAULT_GUIDANCE_BLOCK",
		CustomSystemPrompt:  "CUSTOM_BLOCK",
		ContextText:         "CONTEXT_BLOCK",
		Skills: []Skill{{
			Name: "ops", Description: "d", Prompt: "FULL_SKILL_BODY_NOT_INDEX_ONLY", Enabled: true,
		}},
		Memories: []Memory{{Title: "m1", Content: "secret-ish fact"}},
		EnvVars:  []EnvVar{{Name: "TOKEN", Description: "t", Value: "abc", ValueVisibleToAI: true}},
		Now:      fixed,
	})
	needles := []string{
		"Zephyr AI",
		"DEFAULT_GUIDANCE_BLOCK",
		"2026-07-20T12:00:00Z",
		"CONTEXT_BLOCK",
		"CUSTOM_BLOCK",
		"FULL_SKILL_BODY_NOT_INDEX_ONLY",
		"secret-ish fact",
		"TOKEN",
		"abc",
	}
	for _, n := range needles {
		if !strings.Contains(out, n) {
			t.Fatalf("system prompt missing %q\n%s", n, out)
		}
	}
	// Ensure we did not switch to name-only skill index
	if strings.Contains(out, "Skill catalog") && !strings.Contains(out, "FULL_SKILL_BODY") {
		t.Fatal("skills must be full body injection")
	}
}
