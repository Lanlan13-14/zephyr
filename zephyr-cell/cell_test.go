package cell

import (
	"testing"
	"time"
)

// --- Capability tests (§2.3) ---

func TestCapabilitySet_Has(t *testing.T) {
	cs := CapsDefault.Set(CapPersistShell, CapPTY)
	if !cs.Has(CapPersistShell) {
		t.Error("expected CapPersistShell to be set")
	}
	if !cs.Has(CapPTY) {
		t.Error("expected CapPTY to be set")
	}
	if cs.Has(CapSnapshot) {
		t.Error("CapSnapshot should not be set")
	}
	if cs.Has(CapBrowserOffload) {
		t.Error("CapBrowserOffload should not be set")
	}
}

func TestCapabilitySet_HasMultiple(t *testing.T) {
	cs := CapsCellVM
	if !cs.Has(CapSnapshot, CapPersistShell, CapPTY) {
		t.Error("CellVM should have SNAPSHOT, PERSIST_SHELL, and PTY")
	}
	if cs.Has(CapBrowserOffload) {
		t.Error("CellVM should not have BROWSER_OFFLOAD")
	}
}

func TestCapabilitySet_String(t *testing.T) {
	cs := CapsDefault
	if cs.String() != "NONE" {
		t.Errorf("empty set should be NONE, got %s", cs.String())
	}
	cs = CapsDefault.Set(CapPTY)
	s := cs.String()
	if s != "CapabilitySet(PTY)" {
		t.Errorf("unexpected string: %s", s)
	}
}

// --- Engine capability matrices (§2.3) ---

func TestCapabilityMatrix_Direct(t *testing.T) {
	assertCaps(t, "Direct", CapsDirect,
		[]Capability{CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload},
		[]Capability{CapSnapshot, CapBrowserOffload},
	)
}

func TestCapabilityMatrix_CellVM(t *testing.T) {
	assertCaps(t, "CellVM", CapsCellVM,
		[]Capability{CapSnapshot, CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload},
		[]Capability{CapBrowserOffload},
	)
}

func TestCapabilityMatrix_WSL2(t *testing.T) {
	assertCaps(t, "WSL2", CapsWSL2,
		[]Capability{CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload},
		[]Capability{CapSnapshot, CapBrowserOffload},
	)
}

func TestCapabilityMatrix_PRoot(t *testing.T) {
	assertCaps(t, "PRoot", CapsPRoot,
		[]Capability{CapPersistShell, CapPTY, CapOffload},
		[]Capability{CapSnapshot, CapCgroupLimits, CapNetFilter, CapBrowserOffload},
	)
}

func TestCapabilityMatrix_Asbestos(t *testing.T) {
	assertCaps(t, "Asbestos", CapsAsbestos,
		[]Capability{CapPersistShell, CapPTY, CapOffload},
		[]Capability{CapSnapshot, CapCgroupLimits, CapNetFilter, CapBrowserOffload},
	)
}

func TestCapabilityMatrix_CellServer(t *testing.T) {
	assertCaps(t, "CellServer", CapsCellServer,
		[]Capability{CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload, CapBrowserOffload},
		[]Capability{CapSnapshot},
	)
}

func assertCaps(t *testing.T, name string, cs CapabilitySet, present, absent []Capability) {
	t.Helper()
	for _, c := range present {
		if !cs.Has(c) {
			t.Errorf("%s: expected capability %d to be present", name, c)
		}
	}
	for _, c := range absent {
		if cs.Has(c) {
			t.Errorf("%s: expected capability %d to be absent", name, c)
		}
	}
}

// --- Default limits (§8.1) ---

func TestDefaultLimits(t *testing.T) {
	l := DefaultLimits()
	if l.Cores != 2 {
		t.Errorf("Cores: want 2, got %f", l.Cores)
	}
	if l.MemoryMB != 512 {
		t.Errorf("MemoryMB: want 512, got %d", l.MemoryMB)
	}
	if l.WallClock != 10*time.Minute {
		t.Errorf("WallClock: want 10m, got %s", l.WallClock)
	}
	if l.IdleTimeout != 30*time.Minute {
		t.Errorf("IdleTimeout: want 30m, got %s", l.IdleTimeout)
	}
	if l.MaxOutputKB != 100 {
		t.Errorf("MaxOutputKB: want 100, got %d", l.MaxOutputKB)
	}
	if l.MaxProcs != 128 {
		t.Errorf("MaxProcs: want 128, got %d", l.MaxProcs)
	}
	if l.DiskMB != 1024 {
		t.Errorf("DiskMB: want 1024, got %d", l.DiskMB)
	}
}

// --- Default env (§3.3) ---

func TestDefaultEnv_AllKeysPresent(t *testing.T) {
	env := DefaultEnv("test-session", "direct", "0.1.0")
	expectedKeys := EnvKeys()
	for _, k := range expectedKeys {
		if _, ok := env[k]; !ok {
			t.Errorf("missing key in default env: %s", k)
		}
	}
	// Check specific values
	if env["PATH"] != "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" {
		t.Errorf("PATH mismatch: %s", env["PATH"])
	}
	if env["HOME"] != "/root" {
		t.Errorf("HOME mismatch: %s", env["HOME"])
	}
	if env["ZEPHYR_CELL"] != "1" {
		t.Errorf("ZEPHYR_CELL mismatch: %s", env["ZEPHYR_CELL"])
	}
	if env["ZEPHYR_SESSION_ID"] != "test-session" {
		t.Errorf("ZEPHYR_SESSION_ID mismatch: %s", env["ZEPHYR_SESSION_ID"])
	}
	if env["ZEPHYR_ENGINE"] != "direct" {
		t.Errorf("ZEPHYR_ENGINE mismatch: %s", env["ZEPHYR_ENGINE"])
	}
	if env["TZ"] != "UTC" {
		t.Errorf("TZ must be UTC, got: %s", env["TZ"])
	}
	if env["LANG"] != "C.UTF-8" {
		t.Errorf("LANG must be C.UTF-8, got: %s", env["LANG"])
	}
}

func TestDefaultEnv_KeysSorted(t *testing.T) {
	keys := EnvKeys()
	for i := 1; i < len(keys); i++ {
		if keys[i] < keys[i-1] {
			t.Errorf("EnvKeys not sorted: %s < %s at index %d", keys[i], keys[i-1], i)
		}
	}
}

func TestDefaultEnv_CountMatch(t *testing.T) {
	env := DefaultEnv("s", "e", "v")
	keys := EnvKeys()
	if len(env) != len(keys) {
		t.Errorf("env has %d keys, EnvKeys() has %d — mismatch", len(env), len(keys))
	}
}

// --- Guest paths (§3.2) ---

func TestGuestPaths_AllDefined(t *testing.T) {
	paths := GuestPaths()
	expected := map[string]bool{
		"/cell/workspace":     true,
		"/cell/inbox":         true,
		"/cell/outbox":        true,
		"/cell/tmp":           true,
		"/cell/shared/memory": true,
		"/cell/shared/skills": true,
		"/cell/shared/cache":  true,
	}
	if len(paths) != len(expected) {
		t.Errorf("GuestPaths: want %d, got %d", len(expected), len(paths))
	}
	for _, p := range paths {
		if !expected[p] {
			t.Errorf("unexpected guest path: %s", p)
		}
	}
}

// --- Offload constants (§5) ---

func TestOffloadExitCodes(t *testing.T) {
	if OffloadExitTimeout != 124 {
		t.Errorf("timeout exit code: want 124, got %d", OffloadExitTimeout)
	}
	if OffloadExitPermissionDenied != 125 {
		t.Errorf("permission denied exit code: want 125, got %d", OffloadExitPermissionDenied)
	}
	if OffloadExitUnavailable != 126 {
		t.Errorf("unavailable exit code: want 126, got %d", OffloadExitUnavailable)
	}
	if OffloadExitUnknown != 127 {
		t.Errorf("unknown exit code: want 127, got %d", OffloadExitUnknown)
	}
}

func TestOffloadCommands_AllPresent(t *testing.T) {
	expected := []string{
		"zc-calendar", "zc-contacts", "zc-location", "zc-notify",
		"zc-clipboard", "zc-speak", "zc-speech", "zc-vision",
		"zc-photos", "zc-device", "zc-open", "zc-weather",
		"zc-alarm", "zc-ffmpeg",
	}
	if len(OffloadCommands) != len(expected) {
		t.Errorf("OffloadCommands: want %d, got %d", len(expected), len(OffloadCommands))
	}
	set := make(map[string]bool)
	for _, c := range OffloadCommands {
		set[c] = true
	}
	for _, e := range expected {
		if !set[e] {
			t.Errorf("missing offload command: %s", e)
		}
	}
}

// --- Error model (§6.2 rule 4) ---

func TestCellError_Format(t *testing.T) {
	err := NewError(ErrCodeTimeout, "exec timed out after 10m", nil)
	s := err.Error()
	if s != "cell: TIMEOUT: exec timed out after 10m" {
		t.Errorf("unexpected error format: %s", s)
	}
}

func TestCellError_Unwrap(t *testing.T) {
	inner := NewError(ErrCodeInternal, "disk full", nil)
	outer := NewError(ErrCodeRootfsCorrupt, "base layer corrupt", inner)
	if outer.Unwrap() != inner {
		t.Error("Unwrap should return inner error")
	}
}

func TestCellError_Sentinel(t *testing.T) {
	if ErrEngineUnsupported.Code != ErrCodeEngineUnsupported {
		t.Error("sentinel error code mismatch")
	}
}

// --- Snapshot ---

func TestSnapshotID(t *testing.T) {
	id := SnapshotID("snap-123")
	if id.String() != "snap-123" {
		t.Errorf("String: want snap-123, got %s", id.String())
	}
	if id.IsEmpty() {
		t.Error("should not be empty")
	}
	empty := SnapshotID("")
	if !empty.IsEmpty() {
		t.Error("should be empty")
	}
}

// --- Network policy ---

func TestDefaultNetworkPolicy(t *testing.T) {
	np := DefaultNetworkPolicy()
	if !np.BlockMetadata {
		t.Error("BlockMetadata must default to true")
	}
	if len(np.AllowedDomains) != 0 {
		t.Error("AllowedDomains must default empty (network-isolated)")
	}
	if len(np.AllowedIPs) != 0 {
		t.Error("AllowedIPs must default empty")
	}
	if np.ForceProxy != "" {
		t.Error("ForceProxy must default empty")
	}
}
