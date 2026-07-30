package openai

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
func TestResponsesOmitsChatOnlyParams(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`))
	}))
	defer srv.Close()

	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-5", APIMode: "responses"})
	req := provider.Request{
		Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}},
		Options: map[string]any{
			"temperature":          0.7,
			"top_p":                0.9,
			"max_tokens":           4096,
			"max_output_tokens":    2048,
			"max_completion_tokens": 4096,
			"presence_penalty":     0.5,
			"frequency_penalty":    0.3,
			"reasoning_effort":     "high",
			"response_format":      map[string]any{"type": "json_object"},
			"stop":                 "END",
			"n":                    1,
			"seed":                 42,
			"reasoning":            map[string]any{"effort": "high"},
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

	// Allowed on Responses.
	if body["temperature"] != 0.7 {
		t.Fatalf("temperature should be passed through: %v", body["temperature"])
	}
	if body["top_p"] != 0.9 {
		t.Fatalf("top_p should be passed through: %v", body["top_p"])
	}
	if body["max_output_tokens"] == nil {
		t.Fatal("max_output_tokens missing on responses payload")
	}
	if body["seed"] != float64(42) {
		t.Fatalf("seed should be passed through: %v", body["seed"])
	}
	r, ok := body["reasoning"].(map[string]any)
	if !ok || r["effort"] != "high" {
		t.Fatalf("reasoning object {effort} missing/wrong: %#v", body["reasoning"])
	}

	// Rejected by Responses API - must NOT appear.
	for _, key := range []string{
		"max_tokens", "max_completion_tokens",
		"presence_penalty", "frequency_penalty",
		"reasoning_effort", "response_format", "stop", "n",
	} {
		if _, present := body[key]; present {
			t.Fatalf("chat-only param %q leaked into responses payload: %#v", key, body[key])
		}
	}
}

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
			"max_tokens":           1000,
			"max_output_tokens":    2000,
			"reasoning_effort":     "high",
			"presence_penalty":     0.1,
			"reasoning":            map[string]any{"effort": "high"},
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
func TestEmptyOptionValuesAreOmitted(t *testing.T) {
	payload := map[string]any{}
	applyOptions(payload, map[string]any{
		"temperature":     -1,
		"top_p":           "",
		"max_tokens":      0,
		"reasoning_effort": "",
	}, "chat")
	for _, k := range []string{"temperature", "top_p", "reasoning_effort"} {
		if _, present := payload[k]; present {
			t.Fatalf("%q should be omitted for empty/-1 value: %#v", k, payload[k])
		}
	}
	// max_tokens:0 is a legitimate explicit value (not -1/empty), keep it.
	if v, ok := payload["max_tokens"]; !ok {
		t.Fatalf("max_tokens 0 should be kept, got absent: %#v", payload)
	} else if n, _ := v.(int); n != 0 {
		if f, _ := v.(float64); f != 0 {
			t.Fatalf("max_tokens 0 should be kept, got: %#v", v)
		}
	}
}
