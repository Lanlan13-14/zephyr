package session

import (
	"path/filepath"
	"testing"
)

func TestSessionUsageAggregatesPersistedProviderMetrics(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sess, err := store.CreateSession("u1", "usage", nil)
	if err != nil {
		t.Fatal(err)
	}
	run1, err := store.CreateRun(sess.ID, "u1", "p1", "m1")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateRunStatus(run1.ID, "completed", "", map[string]any{
		"providerCalls": 2, "inputTokens": 100, "outputTokens": 20,
		"cacheCreationTokens": 5, "cacheReadTokens": 10, "latestContextTokens": 115,
	}); err != nil {
		t.Fatal(err)
	}
	run2, err := store.CreateRun(sess.ID, "u1", "p1", "m1")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateRunStatus(run2.ID, "completed", "", map[string]any{
		"providerCalls": 1, "inputTokens": 70, "outputTokens": 8, "latestContextTokens": 70,
	}); err != nil {
		t.Fatal(err)
	}
	usage, err := store.SessionUsage("u1", sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.RunCount != 2 || usage.ProviderCalls != 3 || usage.InputTokens != 170 || usage.OutputTokens != 28 {
		t.Fatalf("bad totals: %+v", usage)
	}
	if usage.CacheCreationTokens != 5 || usage.CacheReadTokens != 10 || usage.LatestContextTokens != 70 {
		t.Fatalf("bad cache/context totals: %+v", usage)
	}
	if usage.LastRun == nil || usage.LastRun.ID != run2.ID {
		t.Fatalf("bad last run: %+v", usage.LastRun)
	}
	if _, err := store.SessionUsage("u2", sess.ID); err == nil {
		t.Fatal("cross-user usage lookup should fail")
	}
}
