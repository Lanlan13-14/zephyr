package anthropic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestAdaptiveThinkingWire(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"content": []map[string]any{{"type": "text", "text": "ok"}}})
	}))
	defer srv.Close()
	p := New(provider.Config{BaseURL: srv.URL})
	chunks, err := p.Stream(context.Background(), provider.Request{Model: "claude-opus-4-8", Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}, Options: map[string]any{"effort": "max"}})
	if err != nil {
		t.Fatal(err)
	}
	for ch := range chunks {
		if ch.Err != nil {
			t.Fatal(ch.Err)
		}
	}
	th, _ := got["thinking"].(map[string]any)
	out, _ := got["output_config"].(map[string]any)
	if th["type"] != "adaptive" || th["display"] != "summarized" || out["effort"] != "max" {
		t.Fatalf("bad payload %#v", got)
	}
	if _, ok := got["temperature"]; ok {
		t.Fatal("adaptive thinking must omit temperature")
	}
}

func TestLegacyThinkingBudgetWire(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"content": []map[string]any{{"type": "text", "text": "ok"}}})
	}))
	defer srv.Close()
	p := New(provider.Config{BaseURL: srv.URL})
	chunks, err := p.Stream(context.Background(), provider.Request{Model: "claude-sonnet-4-5", Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}, Options: map[string]any{"max_tokens": float64(10000), "effort": "low"}})
	if err != nil {
		t.Fatal(err)
	}
	for ch := range chunks {
		if ch.Err != nil {
			t.Fatal(ch.Err)
		}
	}
	th, _ := got["thinking"].(map[string]any)
	if th["type"] != "enabled" || th["budget_tokens"] != float64(8192) || got["temperature"] != float64(1) {
		t.Fatalf("bad payload %#v", got)
	}
}
