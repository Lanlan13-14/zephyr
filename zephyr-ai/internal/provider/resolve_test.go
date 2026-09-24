package provider_test

import (
	"context"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/adapters/anthropic_messages"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/adapters/openai_chat"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/adapters/openai_responses"
)

func TestResolveAPIRoutesEachWireOnce(t *testing.T) {
	cases := []struct {
		kind provider.Kind
		mode string
		want provider.API
	}{
		{provider.KindOpenAI, "", provider.APIOpenAIChat},
		{provider.KindOpenAI, "auto", provider.APIOpenAIChat},
		{provider.KindOpenAI, "chat", provider.APIOpenAIChat},
		{provider.KindOpenAI, "responses", provider.APIOpenAIResponses},
		{provider.KindOpenAIComp, "chat", provider.APIOpenAIChat},
		{provider.KindOpenAIComp, "responses", provider.APIOpenAIResponses},
		{provider.KindAnthropic, "", provider.APIAnthropicMessages},
		{provider.KindAnthropic, "auto", provider.APIAnthropicMessages},
	}
	for _, c := range cases {
		got, err := provider.ResolveAPI(c.kind, c.mode)
		if err != nil || got != c.want {
			t.Fatalf("ResolveAPI(%q,%q) = %q,%v want %q", c.kind, c.mode, got, err, c.want)
		}
	}
}

func TestResolveAPIRejectsUnknownModes(t *testing.T) {
	for _, c := range []struct {
		kind provider.Kind
		mode string
	}{
		{provider.KindAnthropic, "responses"},
		{provider.KindAnthropic, "chat"},
		{provider.KindOpenAI, "messages"},
		{provider.KindOpenAI, "generateContent"},
		{provider.Kind("gemini"), "auto"},
		{provider.Kind("ollama"), "auto"},
	} {
		if _, err := provider.ResolveAPI(c.kind, c.mode); err == nil {
			t.Fatalf("ResolveAPI(%q,%q) should fail", c.kind, c.mode)
		}
	}
}

func TestNewAdapterBuildsRunnableClients(t *testing.T) {
	for _, cfg := range []provider.Config{
		{Kind: provider.KindOpenAI, APIMode: "chat"},
		{Kind: provider.KindOpenAIComp, APIMode: "responses"},
		{Kind: provider.KindAnthropic},
	} {
		p, err := provider.NewAdapter(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.Stream(context.Background(), provider.Request{Model: "m", Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}}); err != nil {
			// Stream must construct the request; network failure happens async on the channel.
			t.Fatal(err)
		}
	}
}

func TestLegacyNewStillRoutes(t *testing.T) {
	// provider.New is the compat path for callers that have not migrated to
	// kind+apiMode resolution yet. It must keep working until removed.
	p, err := provider.New(provider.Config{Kind: provider.KindAnthropic})
	if err != nil || p == nil {
		t.Fatalf("legacy New = %v,%v", p, err)
	}
}
