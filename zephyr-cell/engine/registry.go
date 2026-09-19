package engine

import (
	"context"
	"fmt"
	"runtime"
	"sync"
)

// Registry holds registered engines and selects the best one for the
// current platform (§ADR-002: engine grading, not single runtime).
type Registry struct {
	mu      sync.RWMutex
	engines map[string]Engine
	order   []string // priority order (first match wins)
}

// NewRegistry creates an empty engine registry.
func NewRegistry() *Registry {
	return &Registry{
		engines: make(map[string]Engine),
	}
}

// Register adds an engine to the registry.
// Engines are tried in registration order during Select().
func (r *Registry) Register(e Engine) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name := e.Name()
	r.engines[name] = e
	r.order = append(r.order, name)
}

// Get returns a registered engine by name, or nil if not found.
func (r *Registry) Get(name string) Engine {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.engines[name]
}

// Select probes registered engines in priority order and returns the first
// one that boots successfully. This implements the ADR-002 "choose the best
// engine for this platform" logic.
//
// The probe config is used for boot attempts. Engines that fail to boot
// are skipped (with the error recorded in the returned diagnostics map).
//
// If no engine boots, returns nil and the full diagnostics.
func (r *Registry) Select(ctx context.Context, cfg Config) (Engine, map[string]error) {
	r.mu.RLock()
	order := make([]string, len(r.order))
	copy(order, r.order)
	r.mu.RUnlock()

	diag := make(map[string]error, len(order))
	for _, name := range order {
		e := r.Get(name)
		if e == nil {
			continue
		}
		if err := e.Boot(ctx, cfg); err != nil {
			diag[name] = err
			continue
		}
		return e, diag
	}
	return nil, diag
}

// Names returns the names of all registered engines in priority order.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

// DefaultEngineOrder returns the recommended engine registration order for
// the current GOOS/GOARCH combination (§2.2 engine selection matrix).
// This is advisory; actual registration is done by the host integration layer.
func DefaultEngineOrder() []string {
	switch runtime.GOOS {
	case "linux":
		if runtime.GOARCH == "arm64" {
			return []string{"direct", "qemu"}
		}
		return []string{"direct", "qemu"}
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return []string{"cellvm", "asbestos", "qemu"}
		}
		return []string{"qemu"} // Intel Mac
	case "windows":
		return []string{"wsl2", "qemu"}
	case "android":
		return []string{"proot"}
	case "ios":
		return []string{"asbestos"}
	default:
		return []string{"qemu"}
	}
}

// PlatformInfo returns a diagnostic string describing the current host
// platform for engine selection logging.
func PlatformInfo() string {
	return fmt.Sprintf("GOOS=%s GOARCH=%s", runtime.GOOS, runtime.GOARCH)
}
