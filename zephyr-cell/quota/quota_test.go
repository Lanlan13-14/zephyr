package quota

import (
	"testing"
)

func TestQuota_DefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.GlobalMaxConcurrent != 4 {
		t.Errorf("GlobalMaxConcurrent: want 4, got %d", cfg.GlobalMaxConcurrent)
	}
	if cfg.UserMaxConcurrent != 2 {
		t.Errorf("UserMaxConcurrent: want 2, got %d", cfg.UserMaxConcurrent)
	}
	if cfg.SessionMaxPerHour != 60 {
		t.Errorf("SessionMaxPerHour: want 60, got %d", cfg.SessionMaxPerHour)
	}
	if cfg.MaxWebSessionsPerUser != 5 {
		t.Errorf("MaxWebSessionsPerUser: want 5, got %d", cfg.MaxWebSessionsPerUser)
	}
}

func TestQuota_GlobalLimit(t *testing.T) {
	m := NewManager(Config{GlobalMaxConcurrent: 2})

	// First two should pass
	if err := m.AcquireExec("", "s1"); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if err := m.AcquireExec("", "s2"); err != nil {
		t.Fatalf("second acquire: %v", err)
	}

	// Third should fail
	if err := m.AcquireExec("", "s3"); err == nil {
		t.Error("third acquire should fail (global limit)")
	}

	// Release one
	m.ReleaseExec("")
	if err := m.AcquireExec("", "s3"); err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
}

func TestQuota_UserLimit(t *testing.T) {
	m := NewManager(Config{GlobalMaxConcurrent: 10, UserMaxConcurrent: 1})

	if err := m.AcquireExec("user1", "s1"); err != nil {
		t.Fatal(err)
	}
	if err := m.AcquireExec("user1", "s2"); err == nil {
		t.Error("second exec for same user should fail")
	}

	// Different user should be fine
	if err := m.AcquireExec("user2", "s3"); err != nil {
		t.Fatalf("different user: %v", err)
	}
}

func TestQuota_SessionHourlyLimit(t *testing.T) {
	m := NewManager(Config{SessionMaxPerHour: 3})

	for i := 0; i < 3; i++ {
		if err := m.AcquireExec("", "s1"); err != nil {
			t.Fatalf("acquire #%d: %v", i, err)
		}
		m.ReleaseExec("")
	}

	// Fourth in the same hour should fail
	if err := m.AcquireExec("", "s1"); err == nil {
		t.Error("fourth exec in same hour should fail")
	}
}

func TestQuota_SessionLimit(t *testing.T) {
	m := NewManager(Config{MaxWebSessionsPerUser: 2})

	if err := m.AcquireSession("user1"); err != nil {
		t.Fatal(err)
	}
	if err := m.AcquireSession("user1"); err != nil {
		t.Fatal(err)
	}
	if err := m.AcquireSession("user1"); err == nil {
		t.Error("third session should fail")
	}

	m.ReleaseSession("user1")
	if err := m.AcquireSession("user1"); err != nil {
		t.Fatal("should succeed after release")
	}
}

func TestQuota_Stats(t *testing.T) {
	m := NewManager(Config{GlobalMaxConcurrent: 10, UserMaxConcurrent: 5})

	m.AcquireExec("user1", "s1")
	m.AcquireExec("user1", "s2")
	m.AcquireExec("user2", "s3")

	stats := m.Stats()
	if stats.GlobalActive != 3 {
		t.Errorf("GlobalActive: want 3, got %d", stats.GlobalActive)
	}
	if stats.UserActive["user1"] != 2 {
		t.Errorf("user1 active: want 2, got %d", stats.UserActive["user1"])
	}
	if stats.UserActive["user2"] != 1 {
		t.Errorf("user2 active: want 1, got %d", stats.UserActive["user2"])
	}
}
