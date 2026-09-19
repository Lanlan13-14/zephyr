package pathmap

import (
	"testing"
)

func TestMapper_ToHost(t *testing.T) {
	m := NewMapper("sess-1", "/var/lib/zephyr-cell")

	hostPath, err := m.ToHost("/cell/workspace")
	if err != nil {
		t.Fatal(err)
	}
	if hostPath != "/var/lib/zephyr-cell/sessions/sess-1/workspace" {
		t.Errorf("workspace host path: %s", hostPath)
	}

	// Subpath
	hostPath, err = m.ToHost("/cell/workspace/data.csv")
	if err != nil {
		t.Fatal(err)
	}
	if hostPath != "/var/lib/zephyr-cell/sessions/sess-1/workspace/data.csv" {
		t.Errorf("subpath host path: %s", hostPath)
	}

	// Shared path
	hostPath, err = m.ToHost("/cell/shared/memory")
	if err != nil {
		t.Fatal(err)
	}
	if hostPath != "/var/lib/zephyr-cell/shared/memory" {
		t.Errorf("shared memory host path: %s", hostPath)
	}
}

func TestMapper_ToGuest(t *testing.T) {
	m := NewMapper("sess-1", "/var/lib/zephyr-cell")

	guestPath, err := m.ToGuest("/var/lib/zephyr-cell/sessions/sess-1/workspace")
	if err != nil {
		t.Fatal(err)
	}
	if guestPath != "/cell/workspace" {
		t.Errorf("guest path: %s", guestPath)
	}

	// Subpath
	guestPath, err = m.ToGuest("/var/lib/zephyr-cell/sessions/sess-1/workspace/script.py")
	if err != nil {
		t.Fatal(err)
	}
	if guestPath != "/cell/workspace/script.py" {
		t.Errorf("subpath guest path: %s", guestPath)
	}
}

func TestMapper_UnknownPath(t *testing.T) {
	m := NewMapper("sess-1", "/var/lib/zephyr-cell")

	_, err := m.ToHost("/etc/passwd")
	if err == nil {
		t.Error("unknown guest path should fail")
	}

	_, err = m.ToGuest("/tmp/random")
	if err == nil {
		t.Error("unknown host path should fail")
	}
}

func TestMapper_BindMounts(t *testing.T) {
	m := NewMapper("sess-1", "/data")
	mounts := m.BindMounts()

	if len(mounts) != 7 {
		t.Errorf("bind mounts: want 7, got %d", len(mounts))
	}

	// All guest paths should be present
	for _, p := range []string{"/cell/workspace", "/cell/inbox", "/cell/outbox", "/cell/tmp",
		"/cell/shared/memory", "/cell/shared/skills", "/cell/shared/cache"} {
		if _, ok := mounts[p]; !ok {
			t.Errorf("missing bind mount for %s", p)
		}
	}
}

func TestMapper_HostDirs(t *testing.T) {
	m := NewMapper("sess-1", "/data")
	dirs := m.HostDirs()
	if len(dirs) != 7 {
		t.Errorf("host dirs: want 7, got %d", len(dirs))
	}
}

func TestMapper_SessionDir(t *testing.T) {
	m := NewMapper("sess-1", "/data")
	if m.SessionDir() != "/data/sessions/sess-1" {
		t.Errorf("session dir: %s", m.SessionDir())
	}
}

func TestValidateGuestPath(t *testing.T) {
	valid := []string{
		"/cell/workspace/data.csv",
		"/cell/tmp/scratch",
		"/cell/outbox/result.json",
		"/cell/shared/memory/note.md",
	}
	for _, p := range valid {
		if err := ValidateGuestPath(p); err != nil {
			t.Errorf("should be valid: %s: %v", p, err)
		}
	}

	invalid := []string{
		"relative/path",
		"/etc/passwd",
		"/root/.ssh/id_rsa",
		"/cell/../etc/passwd",
	}
	for _, p := range invalid {
		if err := ValidateGuestPath(p); err == nil {
			t.Errorf("should be invalid: %s", p)
		}
	}
}
