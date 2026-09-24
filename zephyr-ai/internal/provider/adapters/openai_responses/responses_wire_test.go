package openai_responses

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/adapters"
)

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
			"temperature":           0.7,
			"top_p":                 0.9,
			"max_tokens":            4096,
			"max_output_tokens":     2048,
			"max_completion_tokens": 4096,
			"presence_penalty":      0.5,
			"frequency_penalty":     0.3,
			"reasoning_effort":      "high",
			"response_format":       map[string]any{"type": "json_object"},
			"stop":                  "END",
			"n":                     1,
			"seed":                  42,
			"reasoning":             map[string]any{"effort": "high"},
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

func TestResponsesSerializesImageParts(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {}\n\n"))
	}))
	defer srv.Close()
	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-4o", APIMode: "responses"})
	req := provider.Request{Messages: []provider.Message{{
		Role:    provider.RoleUser,
		Content: "观察图片",
		Parts: []provider.ContentPart{
			{Type: "text", Text: "观察图片"},
			{Type: "image_url", ImageURL: "data:image/png;base64,AA=="},
		},
	}}}
	ch, err := c.Stream(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for range ch {
	}
	input, ok := body["input"].([]any)
	if !ok || len(input) != 1 {
		t.Fatalf("input missing: %v", body)
	}
	item, _ := input[0].(map[string]any)
	content, ok := item["content"].([]any)
	if !ok {
		t.Fatalf("content should be array: %v", item)
	}
	foundImage := false
	for _, part := range content {
		pm, _ := part.(map[string]any)
		if pm["type"] == "input_image" {
			foundImage = true
		}
	}
	if !foundImage {
		t.Fatalf("input_image part missing: %v", content)
	}
}

func TestResponsesReasoningEffortDowngradesInsideObject(t *testing.T) {
	var efforts []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		reasoning, _ := body["reasoning"].(map[string]any)
		effort, _ := reasoning["effort"].(string)
		efforts = append(efforts, effort)
		if effort == "max" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"Unsupported value: max for reasoning.effort"}}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()

	client := New(provider.Config{BaseURL: upstream.URL})
	payload := map[string]any{"model": "m", "input": []any{}, "reasoning": map[string]any{"effort": "max"}}
	res, err := client.postWithReasoningFallback(context.Background(), upstream.URL, "openai responses", payload)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(efforts) != 2 || efforts[0] != "max" || efforts[1] != "xhigh" {
		t.Fatalf("unexpected efforts: %#v", efforts)
	}
	reasoning := payload["reasoning"].(map[string]any)
	if reasoning["effort"] != "xhigh" {
		t.Fatalf("nested effort was not downgraded: %#v", payload)
	}
}

func TestApplyOptionsCarriesResponsesReasoning(t *testing.T) {
	payload := map[string]any{}
	adapters.ApplyOptions(payload, map[string]any{"reasoning": map[string]any{"effort": "max"}}, "responses")
	reasoning, ok := payload["reasoning"].(map[string]any)
	if !ok || reasoning["effort"] != "max" {
		t.Fatalf("reasoning object missing: %#v", payload)
	}
}
