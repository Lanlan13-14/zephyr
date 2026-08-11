package session

import (
	"path/filepath"
	"testing"
)

func TestSessionsAreIsolatedByDatabaseGeneration(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "generation.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	oldSession, err := store.CreateSession("same-user-id", "old", nil, "old-generation")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateUserSession("same-user-id", oldSession.ID, "old-generation"); err != nil {
		t.Fatalf("current generation rejected: %v", err)
	}
	if err := store.ValidateUserSession("same-user-id", oldSession.ID, "new-generation"); err == nil || err.Error() != "session_generation_expired" {
		t.Fatalf("old session must be expired in a new generation, got %v", err)
	}
	if _, err := store.GetSession("same-user-id", oldSession.ID, "new-generation"); err == nil {
		t.Fatal("old session was readable through the new generation")
	}

	newSession, err := store.CreateSession("same-user-id", "new", nil, "new-generation")
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := store.ListSessions("same-user-id", 50, "new-generation")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != newSession.ID {
		t.Fatalf("new generation listed foreign sessions: %#v", sessions)
	}
	if _, err := store.SessionUsage("same-user-id", oldSession.ID, "new-generation"); err == nil {
		t.Fatal("old session usage crossed into the new generation")
	}
}
