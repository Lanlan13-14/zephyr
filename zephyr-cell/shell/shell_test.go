package shell

import (
	"testing"
)

func TestPromptDetector_DefaultPatterns(t *testing.T) {
	d, err := NewPromptDetector(DefaultPromptPatterns())
	if err != nil {
		t.Fatalf("NewPromptDetector: %v", err)
	}

	matches := []string{
		"/ # ",
		"~ # ",
		"/cell/workspace # ",
		"root@alpine#",
		"root@alpine# ",
		"user@host$",
		"user@host$ ",
	}
	for _, m := range matches {
		if !d.Detect([]byte(m)) {
			t.Errorf("should match prompt: %q", m)
		}
	}

	nonMatches := []string{
		"hello world",
		"installing packages...",
		"error: file not found",
	}
	for _, m := range nonMatches {
		if d.Detect([]byte(m)) {
			t.Errorf("should NOT match prompt: %q", m)
		}
	}
}

func TestPersistentShell_Generation(t *testing.T) {
	ps, err := NewPersistentShell("s1")
	if err != nil {
		t.Fatal(err)
	}

	if ps.Generation() != 1 {
		t.Errorf("initial generation: want 1, got %d", ps.Generation())
	}

	ps.MarkAlive()
	if !ps.IsAlive() {
		t.Error("should be alive after MarkAlive")
	}

	newGen := ps.MarkDead()
	if newGen != 2 {
		t.Errorf("after MarkDead: want gen 2, got %d", newGen)
	}
	if ps.IsAlive() {
		t.Error("should not be alive after MarkDead")
	}
	if ps.RebuildCount() != 1 {
		t.Errorf("rebuild count: want 1, got %d", ps.RebuildCount())
	}
}

func TestPersistentShell_EnvDiff(t *testing.T) {
	ps, _ := NewPersistentShell("s1")

	// First call: all keys are new
	toSet, toUnset := ps.EnvDiff(map[string]string{
		"PATH":   "/bin",
		"HOME":   "/root",
		"MY_VAR": "hello",
	})
	if len(toSet) != 3 {
		t.Errorf("first call toSet: want 3, got %d", len(toSet))
	}
	if len(toUnset) != 0 {
		t.Errorf("first call toUnset: want 0, got %d", len(toUnset))
	}

	// Second call: MY_VAR removed, NEW_VAR added
	toSet, toUnset = ps.EnvDiff(map[string]string{
		"PATH":    "/bin",
		"HOME":    "/root",
		"NEW_VAR": "world",
	})
	if len(toSet) != 3 {
		t.Errorf("second call toSet: want 3, got %d", len(toSet))
	}
	if len(toUnset) != 1 {
		t.Errorf("second call toUnset: want 1, got %d", len(toUnset))
	}
	if len(toUnset) > 0 && toUnset[0] != "MY_VAR" {
		t.Errorf("unset key: want MY_VAR, got %s", toUnset[0])
	}
}

func TestBuildEnvCommands(t *testing.T) {
	cmd := BuildEnvCommands(
		map[string]string{"PATH": "/bin", "HOME": "/root"},
		[]string{"OLD_VAR"},
	)
	if cmd == "" {
		t.Error("should produce non-empty command")
	}
	// Should contain unset
	if len(cmd) < 10 {
		t.Errorf("command too short: %s", cmd)
	}
}

func TestStripEcho(t *testing.T) {
	output := []byte("echo hello\r\nhello world\r\n")
	stripped := StripEcho(output, "echo hello")
	if string(stripped) != "hello world\r\n" {
		t.Errorf("stripped: %q", stripped)
	}
}

func TestStripEcho_NoMatch(t *testing.T) {
	output := []byte("hello world")
	stripped := StripEcho(output, "different command")
	if string(stripped) != "hello world" {
		t.Errorf("should not modify: %q", stripped)
	}
}
