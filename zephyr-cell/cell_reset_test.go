package cell

import (
	"context"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
)

type resetEngine struct {
	resetCalls int
	resetErr   error
	config     engine.SessionConfig
}

func (e *resetEngine) Name() string                              { return "test" }
func (e *resetEngine) Boot(context.Context, engine.Config) error { return nil }
func (e *resetEngine) SpawnSession(context.Context, engine.SessionConfig) error {
	return nil
}
func (e *resetEngine) Exec(context.Context, string, string, engine.ExecLimits) (*engine.ExecResult, error) {
	return &engine.ExecResult{ExitCode: 0}, nil
}
func (e *resetEngine) ExecStream(context.Context, string, string, engine.ExecLimits, func(engine.StreamLine)) (*engine.ExecResult, error) {
	return &engine.ExecResult{ExitCode: 0}, nil
}
func (e *resetEngine) SpawnPTY(context.Context, string, int, int) (*engine.PTYHandle, error) {
	return nil, engine.ErrUnsupported
}
func (e *resetEngine) Signal(context.Context, string, int) error           { return nil }
func (e *resetEngine) Mount(context.Context, string, string, string) error { return nil }
func (e *resetEngine) Unmount(context.Context, string, string) error       { return nil }
func (e *resetEngine) InterceptExecve(context.Context, string) error       { return nil }
func (e *resetEngine) ResetSession(_ context.Context, cfg engine.SessionConfig) error {
	e.resetCalls++
	e.config = cfg
	return e.resetErr
}
func (e *resetEngine) Teardown(context.Context, string) error { return nil }
func (e *resetEngine) Shutdown(context.Context) error         { return nil }

func newResetTestCell(eng engine.Engine, sessionID string) *Cell {
	return &Cell{
		id:       "cell-1",
		session:  sessionID,
		template: Template{Limits: DefaultLimits()},
		engine:   eng,
		caps:     CapsDirect,
		created:  time.Now(),
		sessionConfig: engine.SessionConfig{
			SessionID: sessionID,
			Env:       map[string]string{"TEMPLATE_ENV": "1"},
			BindMounts: map[string]string{
				GuestWorkspace: "/data/sessions/test/workspace",
			},
			Limits: engine.ExecLimits{WallClockSeconds: 600, MaxOutputBytes: 102400, MaxProcs: 128},
		},
	}
}

func TestCell_ResetDelegatesToEngine(t *testing.T) {
	eng := &resetEngine{}
	c := newResetTestCell(eng, "sess-1")

	if err := c.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if eng.resetCalls != 1 {
		t.Errorf("engine reset calls: want 1, got %d", eng.resetCalls)
	}
	if eng.config.SessionID != "sess-1" {
		t.Errorf("engine received session: want sess-1, got %s", eng.config.SessionID)
	}
	if eng.config.Env["TEMPLATE_ENV"] != "1" {
		t.Error("engine must receive the template environment")
	}
}

func TestCell_ResetClonesConfigMaps(t *testing.T) {
	eng := &resetEngine{}
	c := newResetTestCell(eng, "sess-2")

	if err := c.Reset(); err != nil {
		t.Fatal(err)
	}
	// Mutating the config maps the engine received must not affect the Cell's
	// canonical configuration.
	eng.config.Env["POLLUTED"] = "yes"
	delete(eng.config.BindMounts, GuestWorkspace)

	if err := c.Reset(); err != nil {
		t.Fatal(err)
	}
	if _, polluted := eng.config.Env["POLLUTED"]; polluted {
		t.Error("env map must be cloned per reset call")
	}
	if _, ok := eng.config.BindMounts[GuestWorkspace]; !ok {
		t.Error("bind mounts map must be cloned per reset call")
	}
}

func TestCell_ResetEngineFailureIsStructured(t *testing.T) {
	eng := &resetEngine{resetErr: context.DeadlineExceeded}
	c := newResetTestCell(eng, "sess-3")

	err := c.Reset()
	if err == nil {
		t.Fatal("expected error")
	}
	cellErr, ok := err.(*CellError)
	if !ok {
		t.Fatalf("want *CellError, got %T", err)
	}
	if cellErr.Code != ErrCodeResetFailed {
		t.Errorf("code: want RESET_FAILED, got %s", cellErr.Code)
	}
}

func TestCell_ResetUnsupportedEngine(t *testing.T) {
	eng := &resetEngine{resetErr: engine.ErrUnsupported}
	c := newResetTestCell(eng, "sess-4")

	err := c.Reset()
	if err != ErrEngineUnsupported {
		t.Errorf("want ErrEngineUnsupported, got %v", err)
	}
}

func TestCell_ResetWithoutEngine(t *testing.T) {
	c := &Cell{session: "sess-5"}
	if err := c.Reset(); err != ErrEngineUnavailable {
		t.Errorf("want ErrEngineUnavailable, got %v", err)
	}
}

func TestCell_ResetFillsMissingSessionID(t *testing.T) {
	eng := &resetEngine{}
	c := newResetTestCell(eng, "sess-6")
	c.sessionConfig.SessionID = ""

	if err := c.Reset(); err != nil {
		t.Fatal(err)
	}
	if eng.config.SessionID != "sess-6" {
		t.Errorf("session ID fallback: want sess-6, got %s", eng.config.SessionID)
	}
}
