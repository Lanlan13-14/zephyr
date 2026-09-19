package engine

import (
	"context"
	"fmt"
	"testing"
)

// stubEngine is a minimal engine for testing the registry.
type stubEngine struct {
	name    string
	bootErr error
}

func (s *stubEngine) Name() string                           { return s.name }
func (s *stubEngine) Boot(_ context.Context, _ Config) error { return s.bootErr }
func (s *stubEngine) SpawnSession(_ context.Context, _ SessionConfig) error {
	return ErrUnsupported
}
func (s *stubEngine) Exec(_ context.Context, _ string, _ string, _ ExecLimits) (*ExecResult, error) {
	return nil, ErrUnsupported
}
func (s *stubEngine) ExecStream(_ context.Context, _ string, _ string, _ ExecLimits, _ func(StreamLine)) (*ExecResult, error) {
	return nil, ErrUnsupported
}
func (s *stubEngine) SpawnPTY(_ context.Context, _ string, _, _ int) (*PTYHandle, error) {
	return nil, ErrUnsupported
}
func (s *stubEngine) Signal(_ context.Context, _ string, _ int) error     { return ErrUnsupported }
func (s *stubEngine) Mount(_ context.Context, _, _, _ string) error       { return ErrUnsupported }
func (s *stubEngine) Unmount(_ context.Context, _, _ string) error        { return ErrUnsupported }
func (s *stubEngine) InterceptExecve(_ context.Context, _ string) error   { return ErrUnsupported }
func (s *stubEngine) Teardown(_ context.Context, _ string) error          { return ErrUnsupported }
func (s *stubEngine) Shutdown(_ context.Context) error                    { return nil }

func TestRegistry_RegisterAndGet(t *testing.T) {
	r := NewRegistry()
	e := &stubEngine{name: "test-engine"}
	r.Register(e)

	got := r.Get("test-engine")
	if got == nil {
		t.Fatal("Get should return the registered engine")
	}
	if got.Name() != "test-engine" {
		t.Errorf("Name: want test-engine, got %s", got.Name())
	}
}

func TestRegistry_GetMissing(t *testing.T) {
	r := NewRegistry()
	if r.Get("nonexistent") != nil {
		t.Error("Get should return nil for unregistered engine")
	}
}

func TestRegistry_Names(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubEngine{name: "alpha"})
	r.Register(&stubEngine{name: "beta"})
	r.Register(&stubEngine{name: "gamma"})
	names := r.Names()
	if len(names) != 3 {
		t.Fatalf("Names: want 3, got %d", len(names))
	}
	if names[0] != "alpha" || names[1] != "beta" || names[2] != "gamma" {
		t.Errorf("Names order: %v", names)
	}
}

func TestRegistry_Select_FirstSuccess(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubEngine{name: "fail1", bootErr: fmt.Errorf("no user ns")})
	r.Register(&stubEngine{name: "succeed", bootErr: nil})
	r.Register(&stubEngine{name: "never-tried", bootErr: nil})

	e, diag := r.Select(context.Background(), Config{})
	if e == nil {
		t.Fatal("Select should return the first successful engine")
	}
	if e.Name() != "succeed" {
		t.Errorf("Selected engine: want succeed, got %s", e.Name())
	}
	if diag["fail1"] == nil {
		t.Error("diag should record fail1's error")
	}
	if _, tried := diag["never-tried"]; tried {
		t.Error("never-tried should not have been probed")
	}
}

func TestRegistry_Select_AllFail(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubEngine{name: "e1", bootErr: fmt.Errorf("err1")})
	r.Register(&stubEngine{name: "e2", bootErr: fmt.Errorf("err2")})

	e, diag := r.Select(context.Background(), Config{})
	if e != nil {
		t.Fatal("Select should return nil when all engines fail")
	}
	if len(diag) != 2 {
		t.Errorf("diag: want 2 entries, got %d", len(diag))
	}
}

func TestRegistry_Select_EmptyRegistry(t *testing.T) {
	r := NewRegistry()
	e, diag := r.Select(context.Background(), Config{})
	if e != nil {
		t.Error("Select on empty registry should return nil")
	}
	if len(diag) != 0 {
		t.Error("diag on empty registry should be empty")
	}
}

func TestDefaultEngineOrder(t *testing.T) {
	order := DefaultEngineOrder()
	if len(order) == 0 {
		t.Error("DefaultEngineOrder should return at least one engine")
	}
}

func TestPlatformInfo(t *testing.T) {
	info := PlatformInfo()
	if info == "" {
		t.Error("PlatformInfo should not be empty")
	}
}

func TestErrUnsupported(t *testing.T) {
	if ErrUnsupported.Code != "ENGINE_UNSUPPORTED" {
		t.Errorf("ErrUnsupported.Code: want ENGINE_UNSUPPORTED, got %s", ErrUnsupported.Code)
	}
}
