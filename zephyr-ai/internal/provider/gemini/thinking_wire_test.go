package gemini

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestThinkingConfigWire(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"candidates": []map[string]any{{"content": map[string]any{"parts": []map[string]any{{"text": "ok"}}}}}})
	}))
	defer srv.Close()
	p := New(provider.Config{BaseURL: srv.URL})
	chunks, err := p.Stream(context.Background(), provider.Request{Model: "gemini-2.5-pro", Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}, Options: map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 8192}}})
	if err != nil {
		t.Fatal(err)
	}
	for ch := range chunks {
		if ch.Err != nil {
			t.Fatal(ch.Err)
		}
	}
	gen, _ := got["generationConfig"].(map[string]any)
	th, _ := gen["thinkingConfig"].(map[string]any)
	if th["thinkingBudget"] != float64(8192) {
		t.Fatalf("bad payload %#v", got)
	}
}
