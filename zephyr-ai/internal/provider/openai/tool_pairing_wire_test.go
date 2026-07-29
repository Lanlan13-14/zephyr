package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestChatWireKeepsCompleteToolBatchBeforeVisualObservation(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer srv.Close()
	client := New(provider.Config{BaseURL: srv.URL, APIKey: "k", APIMode: "chat"})
	req := provider.Request{Model: "m", Stream: true, Messages: []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{
			{ID: "c1", Name: "first", Arguments: json.RawMessage(`{}`)},
			{ID: "c2", Name: "second", Arguments: json.RawMessage(`{}`)},
		}},
		{Role: provider.RoleTool, ToolCallID: "c1", Name: "first", Content: `{"ok":true}`},
		{Role: provider.RoleTool, ToolCallID: "c2", Name: "second", Content: `{"ok":true}`},
		{Role: provider.RoleUser, Parts: []provider.ContentPart{{Type: "text", Text: "screen"}, {Type: "image_url", ImageURL: "data:image/png;base64,AA=="}}},
	}}
	ch, err := client.Stream(context.Background(), req)
	if err != nil { t.Fatal(err) }
	for range ch {}
	messages, _ := body["messages"].([]any)
	if len(messages) != 4 { t.Fatalf("messages=%#v", messages) }
	for i, id := range []string{"c1", "c2"} {
		m, _ := messages[i+1].(map[string]any)
		if m["role"] != "tool" || m["tool_call_id"] != id {
			t.Fatalf("tool output %s misplaced: %#v", id, messages)
		}
	}
	visual, _ := messages[3].(map[string]any)
	if visual["role"] != "user" { t.Fatalf("visual precedes tool batch: %#v", messages) }
}
