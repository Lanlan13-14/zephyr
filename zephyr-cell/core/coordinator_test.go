package core

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
)

// --- Stub engine for testing ---

type testEngine struct {
	name    string
	bootErr error
	execFn  func(ctx context.Context, sessionID, cmd string, limits engine.ExecLimits) (*engine.ExecResult, error)
}

func (e *testEngine) Name() string                                                 { return e.name }
func (e *testEngine) Boot(_ context.Context, _ engine.Config) error                { return e.bootErr }
func (e *testEngine) SpawnSession(_ context.Context, _ engine.SessionConfig) error { return nil }
func (e *testEngine) Exec(ctx context.Context, sid, cmd string, l engine.ExecLimits) (*engine.ExecResult, error) {
	if e.execFn != nil {
		return e.execFn(ctx, sid, cmd, l)
	}
	return &engine.ExecResult{Stdout: []byte("ok"), ExitCode: 0, DurationMs: 5}, nil
}
func (e *testEngine) ExecStream(_ context.Context, _ string, _ string, _ engine.ExecLimits, _ func(engine.StreamLine)) (*engine.ExecResult, error) {
	return nil, engine.ErrUnsupported
}
func (e *testEngine) SpawnPTY(_ context.Context, _ string, _, _ int) (*engine.PTYHandle, error) {
	return nil, engine.ErrUnsupported
}
func (e *testEngine) Signal(_ context.Context, _ string, _ int) error   { return nil }
func (e *testEngine) Mount(_ context.Context, _, _, _ string) error     { return nil }
func (e *testEngine) Unmount(_ context.Context, _, _ string) error      { return nil }
func (e *testEngine) InterceptExecve(_ context.Context, _ string) error { return nil }
func (e *testEngine) ResetSession(_ context.Context, _ engine.SessionConfig) error {
	return nil
}
func (e *testEngine) Teardown(_ context.Context, _ string) error { return nil }
func (e *testEngine) Shutdown(_ context.Context) error           { return nil }

// --- Coordinator tests ---

func TestCoordinator_SpawnAndKill(t *testing.T) {
	audit := NewMemoryAuditStore()
	eng := &testEngine{name: "test"}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	tpl := cell.Template{Limits: cell.DefaultLimits()}
	sess, err := coord.SpawnSession(context.Background(), tpl, "sess-1")
	if err != nil {
		t.Fatalf("SpawnSession: %v", err)
	}
	if sess.ID != "sess-1" {
		t.Errorf("session ID: want sess-1, got %s", sess.ID)
	}
	if coord.ActiveSessions() != 1 {
		t.Errorf("active sessions: want 1, got %d", coord.ActiveSessions())
	}

	// Kill
	if err := coord.KillSession(context.Background(), "sess-1"); err != nil {
		t.Fatalf("KillSession: %v", err)
	}
	if coord.ActiveSessions() != 0 {
		t.Errorf("active sessions after kill: want 0, got %d", coord.ActiveSessions())
	}

	// Kill again (idempotent check)
	err = coord.KillSession(context.Background(), "sess-1")
	if err != cell.ErrSessionNotFound {
		t.Errorf("double kill: want ErrSessionNotFound, got %v", err)
	}

	// Check audit
	entries := audit.Query("sess-1", time.Time{}, 0)
	if len(entries) < 2 {
		t.Errorf("audit entries: want >= 2 (spawn+kill), got %d", len(entries))
	}
}

func TestCoordinator_SpawnAutoID(t *testing.T) {
	audit := NewMemoryAuditStore()
	eng := &testEngine{name: "test"}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	sess, err := coord.SpawnSession(context.Background(), cell.Template{Limits: cell.DefaultLimits()}, "")
	if err != nil {
		t.Fatalf("SpawnSession: %v", err)
	}
	if sess.ID == "" {
		t.Error("auto-generated session ID should not be empty")
	}
}

func TestCoordinator_DuplicateSession(t *testing.T) {
	audit := NewMemoryAuditStore()
	eng := &testEngine{name: "test"}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	tpl := cell.Template{Limits: cell.DefaultLimits()}
	_, err := coord.SpawnSession(context.Background(), tpl, "dup")
	if err != nil {
		t.Fatal(err)
	}
	_, err = coord.SpawnSession(context.Background(), tpl, "dup")
	if err == nil {
		t.Error("duplicate session should fail")
	}
}

func TestSession_ExecSerialization(t *testing.T) {
	audit := NewMemoryAuditStore()
	var execOrder []int
	var mu sync.Mutex

	eng := &testEngine{
		name: "test",
		execFn: func(_ context.Context, _, cmd string, _ engine.ExecLimits) (*engine.ExecResult, error) {
			mu.Lock()
			switch cmd {
			case "cmd1":
				execOrder = append(execOrder, 1)
			case "cmd2":
				execOrder = append(execOrder, 2)
			}
			mu.Unlock()
			time.Sleep(10 * time.Millisecond)
			return &engine.ExecResult{Stdout: []byte("ok"), ExitCode: 0}, nil
		},
	}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	sess, _ := coord.SpawnSession(context.Background(), cell.Template{Limits: cell.DefaultLimits()}, "serial")

	// Two concurrent execs should serialize (per-session mutex)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sess.Exec(context.Background(), "cmd1", engine.ExecLimits{WallClockSeconds: 60, MaxOutputBytes: 102400})
	}()
	go func() {
		defer wg.Done()
		time.Sleep(1 * time.Millisecond) // slight delay so cmd1 goes first
		sess.Exec(context.Background(), "cmd2", engine.ExecLimits{WallClockSeconds: 60, MaxOutputBytes: 102400})
	}()
	wg.Wait()

	// Both should have completed
	mu.Lock()
	if len(execOrder) != 2 {
		t.Errorf("expected 2 execs, got %d", len(execOrder))
	}
	mu.Unlock()
}

func TestSession_OutputTruncation(t *testing.T) {
	audit := NewMemoryAuditStore()
	largeOutput := make([]byte, 200*1024) // 200KB
	for i := range largeOutput {
		largeOutput[i] = 'A'
	}

	eng := &testEngine{
		name: "test",
		execFn: func(_ context.Context, _, _ string, _ engine.ExecLimits) (*engine.ExecResult, error) {
			return &engine.ExecResult{Stdout: largeOutput, ExitCode: 0}, nil
		},
	}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	tpl := cell.Template{Limits: cell.DefaultLimits()} // 100KB max
	sess, _ := coord.SpawnSession(context.Background(), tpl, "trunc")

	result, err := sess.Exec(context.Background(), "big", engine.ExecLimits{WallClockSeconds: 60, MaxOutputBytes: 100 * 1024})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !result.Truncated {
		t.Error("output should be truncated")
	}
	if len(result.Stdout) > 100*1024 {
		t.Errorf("stdout should be <= 100KB, got %d", len(result.Stdout))
	}
}

func TestSession_KilledSessionRejects(t *testing.T) {
	audit := NewMemoryAuditStore()
	eng := &testEngine{name: "test"}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	sess, _ := coord.SpawnSession(context.Background(), cell.Template{Limits: cell.DefaultLimits()}, "killme")
	coord.KillSession(context.Background(), "killme")

	_, err := sess.Exec(context.Background(), "echo hi", engine.ExecLimits{})
	if err == nil {
		t.Error("killed session should reject exec")
	}
}

type resetTrackingEngine struct {
	testEngine
	resetCalls int
	lastConfig engine.SessionConfig
	resetErr   error
}

func (e *resetTrackingEngine) ResetSession(_ context.Context, cfg engine.SessionConfig) error {
	e.resetCalls++
	e.lastConfig = cfg
	return e.resetErr
}

func TestCoordinator_ResetPreservesIdentityAndUsesTemplateConfig(t *testing.T) {
	audit := NewMemoryAuditStore()
	eng := &resetTrackingEngine{testEngine: testEngine{name: "test"}}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

	tpl := cell.Template{
		Env:    map[string]string{"USER_VALUE": "kept"},
		Limits: cell.DefaultLimits(),
	}
	sess, err := coord.SpawnSession(context.Background(), tpl, "reset-1")
	if err != nil {
		t.Fatalf("SpawnSession: %v", err)
	}
	cellID, sessionID := sess.CellID, sess.ID

	if err := coord.ResetSession(context.Background(), sessionID); err != nil {
		t.Fatalf("ResetSession: %v", err)
	}
	if eng.resetCalls != 1 {
		t.Fatalf("reset calls: want 1, got %d", eng.resetCalls)
	}
	if sess.CellID != cellID || sess.ID != sessionID {
		t.Fatal("reset must preserve Cell and session identity")
	}
	if eng.lastConfig.SessionID != sessionID {
		t.Errorf("reset config session: want %s, got %s", sessionID, eng.lastConfig.SessionID)
	}
	if eng.lastConfig.Env["USER_VALUE"] != "kept" {
		t.Error("reset must reuse template environment")
	}

	entries := audit.Query(sessionID, time.Time{}, 0)
	var resetCount int
	for _, entry := range entries {
		if entry.Kind == cell.AuditReset {
			resetCount++
		}
	}
	if resetCount != 1 {
		t.Errorf("reset audit entries: want 1, got %d", resetCount)
	}
}

func TestCoordinator_ResetIsIdempotent(t *testing.T) {
	eng := &resetTrackingEngine{testEngine: testEngine{name: "test"}}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", NewMemoryAuditStore())
	_, err := coord.SpawnSession(context.Background(), cell.Template{Limits: cell.DefaultLimits()}, "reset-2")
	if err != nil {
		t.Fatal(err)
	}
	if err := coord.ResetSession(context.Background(), "reset-2"); err != nil {
		t.Fatal(err)
	}
	if err := coord.ResetSession(context.Background(), "reset-2"); err != nil {
		t.Fatal(err)
	}
	if eng.resetCalls != 2 {
		t.Errorf("reset calls: want 2, got %d", eng.resetCalls)
	}
}

func TestCoordinator_ResetFailureIsStructuredAndAudited(t *testing.T) {
	resetErr := fmt.Errorf("recreate failed")
	eng := &resetTrackingEngine{testEngine: testEngine{name: "test"}, resetErr: resetErr}
	audit := NewMemoryAuditStore()
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)
	_, err := coord.SpawnSession(context.Background(), cell.Template{Limits: cell.DefaultLimits()}, "reset-3")
	if err != nil {
		t.Fatal(err)
	}

	err = coord.ResetSession(context.Background(), "reset-3")
	if err == nil {
		t.Fatal("expected reset failure")
	}
	cellErr, ok := err.(*cell.CellError)
	if !ok || cellErr.Code != cell.ErrCodeResetFailed {
		t.Fatalf("want RESET_FAILED CellError, got %T: %v", err, err)
	}
	entries := audit.Query("reset-3", time.Time{}, 0)
	if len(entries) < 2 || entries[len(entries)-1].Error == "" {
		t.Error("failed reset must append an error audit entry")
	}
}

func TestCoordinator_ResetMissingAndKilledSession(t *testing.T) {
	eng := &resetTrackingEngine{testEngine: testEngine{name: "test"}}
	coord := NewCoordinator(eng, cell.CapsDirect, "0.1.0", NewMemoryAuditStore())
	if err := coord.ResetSession(context.Background(), "missing"); err != cell.ErrSessionNotFound {
		t.Errorf("missing reset: want ErrSessionNotFound, got %v", err)
	}
	_, err := coord.SpawnSession(context.Background(), cell.Template{Limits: cell.DefaultLimits()}, "reset-4")
	if err != nil {
		t.Fatal(err)
	}
	if err := coord.KillSession(context.Background(), "reset-4"); err != nil {
		t.Fatal(err)
	}
	if err := coord.ResetSession(context.Background(), "reset-4"); err != cell.ErrSessionNotFound {
		t.Errorf("killed/removed reset: want ErrSessionNotFound, got %v", err)
	}
}

func TestMemoryAuditStore_RecordAndQuery(t *testing.T) {
	store := NewMemoryAuditStore()

	store.Record(cell.AuditEntry{TS: time.Now(), Session: "s1", Kind: cell.AuditExec, Cmd: "echo 1"})
	store.Record(cell.AuditEntry{TS: time.Now(), Session: "s2", Kind: cell.AuditExec, Cmd: "echo 2"})
	store.Record(cell.AuditEntry{TS: time.Now(), Session: "s1", Kind: cell.AuditExec, Cmd: "echo 3"})

	if store.Count() != 3 {
		t.Errorf("count: want 3, got %d", store.Count())
	}

	s1 := store.Query("s1", time.Time{}, 0)
	if len(s1) != 2 {
		t.Errorf("s1 entries: want 2, got %d", len(s1))
	}

	s2 := store.Query("s2", time.Time{}, 0)
	if len(s2) != 1 {
		t.Errorf("s2 entries: want 1, got %d", len(s2))
	}

	all := store.Query("", time.Time{}, 0)
	if len(all) != 3 {
		t.Errorf("all entries: want 3, got %d", len(all))
	}
}

func TestMemoryAuditStore_Export(t *testing.T) {
	store := NewMemoryAuditStore()
	store.Record(cell.AuditEntry{TS: time.Now(), Session: "s1", Kind: cell.AuditExec, Cmd: "echo 1"})

	data, err := store.Export("s1")
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if len(data) == 0 {
		t.Error("export should not be empty")
	}
}

func TestCrashScene(t *testing.T) {
	scene := CaptureCrashScene("sess-1", "direct", "v1.0", []string{"echo 1", "echo 2"}, fmt.Errorf("SIGSEGV"))
	if scene.SessionID != "sess-1" {
		t.Errorf("SessionID: want sess-1, got %s", scene.SessionID)
	}
	if scene.Error != "SIGSEGV" {
		t.Errorf("Error: want SIGSEGV, got %s", scene.Error)
	}
	if len(scene.RecentCommands) != 2 {
		t.Errorf("RecentCommands: want 2, got %d", len(scene.RecentCommands))
	}
}

// --- Rate limiter tests ---

func TestRateLimiter_Basic(t *testing.T) {
	rl := NewRateLimiter(3, time.Hour)

	for i := 0; i < 3; i++ {
		if !rl.Allow() {
			t.Errorf("Allow() #%d should succeed", i)
		}
	}
	if rl.Allow() {
		t.Error("Allow() #4 should be denied")
	}
	if rl.Count() != 3 {
		t.Errorf("Count: want 3, got %d", rl.Count())
	}
}

// --- QuotaTracker tests ---

func TestQuotaTracker_OutputTruncation(t *testing.T) {
	qt := NewQuotaTracker(cell.DefaultLimits())

	// Under limit
	allowed, trunc := qt.CheckOutput(50 * 1024)
	if trunc {
		t.Error("50KB should not be truncated")
	}
	if allowed != 50*1024 {
		t.Errorf("allowed: want %d, got %d", 50*1024, allowed)
	}

	// Over limit
	allowed, trunc = qt.CheckOutput(200 * 1024)
	if !trunc {
		t.Error("200KB should be truncated")
	}
	if allowed != 100*1024 {
		t.Errorf("allowed: want %d, got %d", 100*1024, allowed)
	}
}
