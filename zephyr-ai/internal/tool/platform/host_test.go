package platform

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListTools(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/ai-host/v1/tools" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "tools": []map[string]any{{"name": "connection_list_v1", "description": "list", "parameters": map[string]any{"type": "object"}}}})
	}))
	defer srv.Close()
	h := NewHost(srv.URL, "")
	tools, err := h.ListTools(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != "connection_list_v1" {
		t.Fatalf("unexpected tools: %#v", tools)
	}
}

func TestCallSendsConfirmedOnlyForMatchingApprovedTool(t *testing.T) {
	var got CallRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]any{"ok": true}})
	}))
	defer srv.Close()
	h := NewHost(srv.URL, "")
	ctx := WithConfirmedCall(context.Background(), "connection_rename_v1")
	_, err := h.Call(ctx, CallRequest{Tool: "connection_rename_v1", UserID: "u", Confirmed: confirmedCallFromContext(ctx, "connection_rename_v1")})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Confirmed {
		t.Fatal("approved matching tool must send confirmed=true")
	}
	if confirmedCallFromContext(ctx, "connection_delete_v1") {
		t.Fatal("approval must not transfer to a different tool")
	}
}
