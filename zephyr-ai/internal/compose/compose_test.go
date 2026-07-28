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

func TestStablePrefixIgnoresTimeAndContext(t *testing.T) {
	base := Input{
		AssistantName:       "Zephyr AI",
		DefaultSystemPrompt: "GUIDANCE",
		CustomSystemPrompt:  "CUSTOM",
		Skills:              []Skill{{ID: "s1", Name: "ops", Prompt: "BODY", Enabled: true}},
		Memories:            []Memory{{Title: "m", Content: "fact"}},
		EnvVars:             []EnvVar{{Name: "E", Value: "1", ValueVisibleToAI: true}},
		Locale:              "zh-CN",
	}
	a := base
	a.ContextText = "CTX_A"
	a.Now = time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	b := base
	b.ContextText = "CTX_B"
	b.Now = time.Date(2026, 7, 20, 13, 0, 0, 0, time.UTC)
	b.RoutingHint = "route-me"

	ra, rb := Build(a), Build(b)
	if ra.StableHash != rb.StableHash {
		t.Fatalf("stable hash must ignore time/context/routing: %s vs %s", ra.StableHash, rb.StableHash)
	}
	if strings.Contains(ra.Stable, "CTX_A") || strings.Contains(ra.Stable, "2026-07-20T12:00:00Z") {
		t.Fatalf("stable must not include volatile context/time: %s", ra.Stable)
	}
	if !strings.Contains(rb.Volatile, "CTX_B") || !strings.Contains(rb.Volatile, "route-me") {
		t.Fatalf("volatile missing context/routing: %s", rb.Volatile)
	}
	if !strings.Contains(ra.Full, "GUIDANCE") || !strings.Contains(ra.Full, "BODY") {
		t.Fatalf("full assembly lost skills/guidance")
	}
}

func TestStableHashChangesWhenSkillChanges(t *testing.T) {
	a := Build(Input{DefaultSystemPrompt: "G", Skills: []Skill{{ID: "s1", Name: "a", Prompt: "P1", Enabled: true}}})
	b := Build(Input{DefaultSystemPrompt: "G", Skills: []Skill{{ID: "s1", Name: "a", Prompt: "P2", Enabled: true}}})
	if a.StableHash == b.StableHash {
		t.Fatal("skill body change must change stable hash")
	}
}
