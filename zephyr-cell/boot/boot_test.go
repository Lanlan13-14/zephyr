package boot

import (
	"context"
	"fmt"
	"testing"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
)

type bootTestEngine struct {
	name    string
	bootErr error
	execFn  func(ctx context.Context, sid, cmd string, l engine.ExecLimits) (*engine.ExecResult, error)
}

func (e *bootTestEngine) Name() string                                     { return e.name }
func (e *bootTestEngine) Boot(_ context.Context, _ engine.Config) error    { return e.bootErr }
func (e *bootTestEngine) SpawnSession(_ context.Context, _ engine.SessionConfig) error { return nil }
func (e *bootTestEngine) Exec(ctx context.Context, sid, cmd string, l engine.ExecLimits) (*engine.ExecResult, error) {
	if e.execFn != nil {
		return e.execFn(ctx, sid, cmd, l)
	}
	return &engine.ExecResult{Stdout: []byte("ok\n"), ExitCode: 0}, nil
}
func (e *bootTestEngine) ExecStream(_ context.Context, _ string, _ string, _ engine.ExecLimits, _ func(engine.StreamLine)) (*engine.ExecResult, error) {
	return nil, engine.ErrUnsupported
}
func (e *bootTestEngine) SpawnPTY(_ context.Context, _ string, _, _ int) (*engine.PTYHandle, error) {
	return nil, engine.ErrUnsupported
}
func (e *bootTestEngine) Signal(_ context.Context, _ string, _ int) error { return nil }
func (e *bootTestEngine) Mount(_ context.Context, _, _, _ string) error   { return nil }
func (e *bootTestEngine) Unmount(_ context.Context, _, _ string) error    { return nil }
func (e *bootTestEngine) InterceptExecve(_ context.Context, _ string) error { return nil }
func (e *bootTestEngine) Teardown(_ context.Context, _ string) error      { return nil }
func (e *bootTestEngine) Shutdown(_ context.Context) error                { return nil }

func TestDetectHost(t *testing.T) {
	info := DetectHost()
	if info.OS == "" {
		t.Error("OS should not be empty")
	}
	if info.Arch == "" {
		t.Error("Arch should not be empty")
	}
}

func TestSelectRootfsVariant(t *testing.T) {
	arm := SelectRootfsVariant(HostInfo{Arch: "arm64"})
	if arm != "aarch64" {
		t.Errorf("arm64 variant: want aarch64, got %s", arm)
	}

	x86 := SelectRootfsVariant(HostInfo{Arch: "amd64"})
	if x86 != "x86_64" {
		t.Errorf("amd64 variant: want x86_64, got %s", x86)
	}
}

func TestBoot_Success(t *testing.T) {
	reg := engine.NewRegistry()
	reg.Register(&bootTestEngine{name: "direct"})

	result := Run(context.Background(), reg, engine.Config{})
	if result.Engine == nil {
		t.Fatal("engine should not be nil on success")
	}
	if result.Engine.Name() != "direct" {
		t.Errorf("engine name: want direct, got %s", result.Engine.Name())
	}
	if result.Caps != cell.CapsDirect {
		t.Errorf("caps mismatch")
	}
	if result.Duration == 0 {
		t.Error("duration should be > 0")
	}
}

func TestBoot_AllFail(t *testing.T) {
	reg := engine.NewRegistry()

	result := Run(context.Background(), reg, engine.Config{})
	if result.Engine != nil {
		t.Error("engine should be nil when all fail")
	}
	if len(result.Diagnostics) == 0 {
		t.Error("should have diagnostics")
	}
}

func TestDiagnostic_String(t *testing.T) {
	d := Diagnostic{
		Step:   "engine_boot",
		Engine: "direct",
		Error:  fmt.Errorf("user ns disabled"),
		Hint:   "enable it",
	}
	s := d.String()
	if s == "" {
		t.Error("diagnostic string should not be empty")
	}
}

func TestHealthCheck(t *testing.T) {
	eng := &bootTestEngine{name: "test"}
	if err := HealthCheck(context.Background(), eng); err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
}
