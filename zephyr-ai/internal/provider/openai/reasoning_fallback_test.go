package openai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestApplyOptionsCarriesResponsesReasoning(t *testing.T) {
	payload := map[string]any{}
	applyOptions(payload, map[string]any{"reasoning": map[string]any{"effort": "max"}})
	reasoning, ok := payload["reasoning"].(map[string]any)
	if !ok || reasoning["effort"] != "max" {
		t.Fatalf("reasoning object missing: %#v", payload)
	}
}

func TestChatReasoningEffortDowngradesOnExplicitRejection(t *testing.T) {
	var efforts []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		effort, _ := body["reasoning_effort"].(string)
		efforts = append(efforts, effort)
		if effort == "xhigh" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"Invalid reasoning_effort: xhigh"}}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()

	client := New(provider.Config{BaseURL: upstream.URL})
	payload := map[string]any{"model": "m", "messages": []any{}, "reasoning_effort": "xhigh"}
	res, err := client.postWithReasoningFallback(context.Background(), upstream.URL, "openai chat", payload)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(efforts) != 2 || efforts[0] != "xhigh" || efforts[1] != "high" {
		t.Fatalf("unexpected efforts: %#v", efforts)
	}
	if payload["reasoning_effort"] != "high" {
		t.Fatalf("payload was not downgraded: %#v", payload)
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

func TestUnrelatedBadRequestDoesNotRetry(t *testing.T) {
	attempts := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"No tool output found"}}`)
	}))
	defer upstream.Close()

	client := New(provider.Config{BaseURL: upstream.URL})
	payload := map[string]any{"reasoning_effort": "xhigh"}
	if _, err := client.postWithReasoningFallback(context.Background(), upstream.URL, "openai chat", payload); err == nil {
		t.Fatal("expected upstream error")
	}
	if attempts != 1 {
		t.Fatalf("unrelated error retried %d times", attempts)
	}
}
