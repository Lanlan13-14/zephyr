package platform

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
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
	tools, err := h.ListTools(context.Background(), nil, "u", "run", "generation", "nonce")
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Name != "connection_list_v1" {
		t.Fatalf("unexpected tools: %#v", tools)
	}
}

func TestListToolsCarriesRemoteDesktopContext(t *testing.T) {
	var gotContext string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContext = r.URL.Query().Get("context")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "tools": []map[string]any{}})
	}))
	defer srv.Close()
	h := NewHost(srv.URL, "")
	contextJSON := json.RawMessage(`{"activeSurface":{"kind":"remote-desktop","tabId":"rdp-1"}}`)
	if _, err := h.ListTools(context.Background(), contextJSON, "u", "run", "generation", "nonce"); err != nil {
		t.Fatal(err)
	}
	if gotContext != string(contextJSON) {
		t.Fatalf("context mismatch: %q", gotContext)
	}
}

func TestCallPropagatesBusiness403FromNotesGate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    false,
			"error": "当前用户未启用笔记功能",
			"code":  "notes_disabled",
		})
	}))
	defer srv.Close()
	h := NewHost(srv.URL, "token")
	_, err := h.Call(context.Background(), CallRequest{Tool: "note_list", UserID: "u1"})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := err.Error(); got == "platform host unauthorized: 403 Forbidden" || !strings.Contains(got, "未启用笔记") {
		t.Fatalf("business 403 must surface notes message, got %q", got)
	}
	if strings.Contains(err.Error(), "platform host unauthorized") {
		t.Fatalf("must not mask notes_disabled as host unauthorized: %v", err)
	}
}

func TestCallKeepsUnauthorizedForHostAuth403(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "unauthorized"})
	}))
	defer srv.Close()
	h := NewHost(srv.URL, "token")
	_, err := h.Call(context.Background(), CallRequest{Tool: "note_list", UserID: "u1"})
	if err == nil || !strings.Contains(err.Error(), "platform host unauthorized") {
		t.Fatalf("expected host unauthorized, got %v", err)
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

func TestInjectCatalogIdentity(t *testing.T) {
	original := json.RawMessage(`{"aiChatSessionId":"chat-1","activeSurface":{"kind":"terminal"}}`)
	merged := injectCatalogIdentity(original, "user-1", "runtime-1")
	var got map[string]any
	if err := json.Unmarshal(merged, &got); err != nil {
		t.Fatal(err)
	}
	if got["userId"] != "user-1" || got["actorUserId"] != "user-1" {
		t.Fatalf("user identity missing: %#v", got)
	}
	if got["runtimeSessionId"] != "runtime-1" {
		t.Fatalf("runtime session missing: %#v", got)
	}
	if got["aiChatSessionId"] != "chat-1" {
		t.Fatalf("browser context was not preserved: %#v", got)
	}
}

func TestRegisterFromHostInjectsIdentityForToolDiscovery(t *testing.T) {
	var discoveredContext string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		discoveredContext = r.URL.Query().Get("context")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "tools": []map[string]any{}})
	}))
	defer srv.Close()

	h := NewHost(srv.URL, "")
	reg := tool.NewRegistry()
	browserContext := json.RawMessage(`{"aiChatSessionId":"chat-1"}`)
	if err := RegisterFromHost(context.Background(), reg, h, "user-1", "runtime-1", "run-1", "generation-1", "nonce-1", browserContext); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(discoveredContext), &got); err != nil {
		t.Fatalf("invalid discovery context %q: %v", discoveredContext, err)
	}
	if got["userId"] != "user-1" || got["runtimeSessionId"] != "runtime-1" {
		t.Fatalf("identity was not injected into discovery context: %#v", got)
	}
	if got["aiChatSessionId"] != "chat-1" {
		t.Fatalf("original browser context was lost: %#v", got)
	}
}
