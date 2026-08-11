package session

import (
	"path/filepath"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestBootstrapMessagesIsOwnerScopedPlainAndIdempotent(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "runtime.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	session, err := store.CreateSession("alice", "canonical", nil)
	if err != nil {
		t.Fatal(err)
	}
	transcript := []provider.Message{
		{Role: provider.RoleUser, Content: "question"},
		{Role: provider.RoleAssistant, Content: "answer"},
	}
	imported, err := store.BootstrapMessages("alice", session.ID, transcript)
	if err != nil || !imported {
		t.Fatalf("first bootstrap imported=%v err=%v", imported, err)
	}
	imported, err = store.BootstrapMessages("alice", session.ID, transcript)
	if err != nil || imported {
		t.Fatalf("replayed bootstrap imported=%v err=%v", imported, err)
	}
	messages, err := store.ProviderMessages(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Content != "question" || messages[1].Content != "answer" {
		t.Fatalf("unexpected transcript %#v", messages)
	}
	if _, err := store.BootstrapMessages("bob", session.ID, transcript); err == nil {
		t.Fatal("foreign owner must not bootstrap runtime history")
	}
}

func TestBootstrapMessagesRejectsNonPersistentFields(t *testing.T) {
	for name, message := range map[string]provider.Message{
		"system":       {Role: provider.RoleSystem, Content: "secret system"},
		"tool":         {Role: provider.RoleTool, Content: "secret tool"},
		"parts":        {Role: provider.RoleUser, Content: "x", Parts: []provider.ContentPart{{Type: "text", Text: "secret part"}}},
		"tool-calls":   {Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "c", Name: "secret", Arguments: []byte(`{"apiKey":"secret"}`)}}},
		"tool-call-id": {Role: provider.RoleAssistant, ToolCallID: "secret-call"},
		"name":         {Role: provider.RoleUser, Name: "volatile-context", Content: "x"},
		"response-id":  {Role: provider.RoleAssistant, ResponseID: "provider-secret", Content: "x"},
	} {
		t.Run(name, func(t *testing.T) {
			store, err := Open(filepath.Join(t.TempDir(), "runtime.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			session, _ := store.CreateSession("alice", "canonical", nil)
			if _, err := store.BootstrapMessages("alice", session.ID, []provider.Message{message}); err == nil {
				t.Fatalf("unsafe bootstrap message accepted: %#v", message)
			}
			messages, err := store.ProviderMessages(session.ID)
			if err != nil || len(messages) != 0 {
				t.Fatalf("rejected bootstrap changed transcript: %#v err=%v", messages, err)
			}
		})
	}
}
