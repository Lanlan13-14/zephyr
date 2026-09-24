package openai_chat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

// TestResponsesOmitsChatOnlyParams guards against OpenAI Responses API
// InvalidParameter errors caused by Chat-Completions-only fields leaking into
// the payload. presence_penalty, frequency_penalty, max_completion_tokens,
// top-level reasoning_effort, response_format, stop, and n are rejected by
// /v1/responses.

// TestChatOmitsResponsesOnlyParams is the symmetric guard for Chat Completions:
// max_output_tokens is not a chat field and must be aliased to max_tokens.
func TestChatOmitsResponsesOnlyParams(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chat_1","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer srv.Close()

	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-4o", APIMode: "chat"})
	req := provider.Request{
		Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}},
		Options: map[string]any{
			"max_tokens":        1000,
			"max_output_tokens": 2000,
			"reasoning_effort":  "high",
			"presence_penalty":  0.1,
			"reasoning":         map[string]any{"effort": "high"},
		},
	}
	ch, err := c.Stream(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for chunk := range ch {
		if chunk.Err != nil {
			t.Fatalf("chunk error: %v", chunk.Err)
		}
	}
	// Chat Completions uses max_tokens, not max_output_tokens.
	if body["max_tokens"] == nil {
		t.Fatal("max_tokens missing on chat payload")
	}
	if _, present := body["max_output_tokens"]; present {
		t.Fatalf("max_output_tokens should not appear on chat payload: %#v", body["max_output_tokens"])
	}
	if body["reasoning_effort"] != "high" {
		t.Fatalf("reasoning_effort should be passed through on chat: %v", body["reasoning_effort"])
	}
}

// TestEmptyOptionValuesAreOitted ensures -1/empty-string convention does not
// produce illegal zero-ish params that some upstreams reject.
