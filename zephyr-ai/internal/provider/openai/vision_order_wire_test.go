package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

// Observation must stay between the capture tool result and the next assistant
// turn — never moved to the end of the request (S0-hotfix order contract).
func TestChatCompletionKeepsObservationBetweenToolAndAssistant(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()
	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-4o"})
	req := provider.Request{Messages: []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "屏幕上有什么"},
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "c1", Name: "remote_desktop_capture_v1", Arguments: json.RawMessage(`{}`)}}},
		{Role: provider.RoleTool, ToolCallID: "c1", Name: "remote_desktop_capture_v1", Content: `{"ok":true}`},
		{
			Role:    provider.RoleUser,
			Name:    "zephyr.visual_observation",
			Content: "meta",
			Parts: []provider.ContentPart{
				{Type: "text", Text: "meta"},
				{Type: "image_url", ImageURL: "data:image/png;base64,AA=="},
			},
		},
		{Role: provider.RoleAssistant, Content: "看到桌面"},
	}}
	ch, err := c.Stream(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for range ch {
	}
	msgs, ok := body["messages"].([]any)
	if !ok || len(msgs) < 5 {
		t.Fatalf("messages missing: %v", body)
	}
	// Find image-bearing user message index and tool message index.
	imgIdx, toolIdx := -1, -1
	for i, raw := range msgs {
		m, _ := raw.(map[string]any)
		role, _ := m["role"].(string)
		if role == "tool" {
			toolIdx = i
		}
		if role == "user" {
			if content, ok := m["content"].([]any); ok {
				for _, part := range content {
					pm, _ := part.(map[string]any)
					if pm["type"] == "image_url" {
						imgIdx = i
					}
				}
			}
		}
	}
	if toolIdx < 0 || imgIdx < 0 {
		t.Fatalf("tool/image missing: tool=%d img=%d body=%v", toolIdx, imgIdx, body)
	}
	if imgIdx != toolIdx+1 {
		t.Fatalf("image must immediately follow capture tool result: tool=%d img=%d", toolIdx, imgIdx)
	}
	if imgIdx == len(msgs)-1 {
		t.Fatalf("image must not sit at global end: len=%d", len(msgs))
	}
}
