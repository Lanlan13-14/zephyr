// Package tool defines the tool contract and registry.
//
// Every tool must declare:
//   - stable Name (snake_case)
//   - Description (model-facing)
//   - JSON Schema Parameters
//   - ReadOnly / Risk for permission + parallel dispatch
//
// Schema is canonicalized on registration; tests snapshot the contract.
package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
)

type Risk string

const (
	RiskLow          Risk = "low"
	RiskHigh         Risk = "high"
	RiskDestructive  Risk = "destructive"
)

// Tool is the execute surface. Args are raw JSON from the model.
type Tool interface {
	Name() string
	Description() string
	Schema() json.RawMessage
	ReadOnly() bool
	Risk() Risk
	// ParallelSafe means concurrent calls with other ParallelSafe tools are OK.
	ParallelSafe() bool
	Execute(ctx context.Context, args json.RawMessage) (any, error)
}

// Result is a structured tool outcome the agent feeds back.
type Result struct {
	OK                   bool   `json:"ok"`
	Data                 any    `json:"data,omitempty"`
	Error                string `json:"error,omitempty"`
	ConfirmationRequired bool   `json:"confirmationRequired,omitempty"`
	Confirmation         any    `json:"confirmation,omitempty"`
	ClientCapture        any    `json:"clientCapture,omitempty"`
	ClientCaptureRequired bool  `json:"clientCaptureRequired,omitempty"`
}

// FuncTool adapts plain functions.
type FuncTool struct {
	ToolName        string
	ToolDescription string
	ToolSchema      json.RawMessage
	IsReadOnly      bool
	ToolRisk        Risk
	IsParallelSafe  bool
	Fn              func(ctx context.Context, args json.RawMessage) (any, error)
}

func (t *FuncTool) Name() string              { return t.ToolName }
func (t *FuncTool) Description() string       { return t.ToolDescription }
func (t *FuncTool) Schema() json.RawMessage   { return t.ToolSchema }
func (t *FuncTool) ReadOnly() bool            { return t.IsReadOnly }
func (t *FuncTool) Risk() Risk {
	if t.ToolRisk == "" {
		if t.IsReadOnly {
			return RiskLow
		}
		return RiskHigh
	}
	return t.ToolRisk
}
func (t *FuncTool) ParallelSafe() bool { return t.IsParallelSafe && t.IsReadOnly }
func (t *FuncTool) Execute(ctx context.Context, args json.RawMessage) (any, error) {
	if t.Fn == nil {
		return nil, fmt.Errorf("tool %s: nil handler", t.ToolName)
	}
	return t.Fn(ctx, args)
}

// Registry is assembled per run (builtins + MCP + filtered).
type Registry struct {
	mu    sync.RWMutex
	byName map[string]Tool
}

func NewRegistry() *Registry {
	return &Registry{byName: make(map[string]Tool)}
}

func (r *Registry) Register(t Tool) error {
	if t == nil {
		return fmt.Errorf("tool: nil")
	}
	name := t.Name()
	if name == "" {
		return fmt.Errorf("tool: empty name")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.byName[name]; exists {
		return fmt.Errorf("tool: duplicate %q", name)
	}
	r.byName[name] = t
	return nil
}

func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.byName[name]
	return t, ok
}

func (r *Registry) List() []Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.byName))
	for n := range r.byName {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]Tool, 0, len(names))
	for _, n := range names {
		out = append(out, r.byName[n])
	}
	return out
}

func (r *Registry) Schemas() []struct {
	Name, Description string
	Parameters        json.RawMessage
	ReadOnly          bool
	Risk              Risk
} {
	list := r.List()
	out := make([]struct {
		Name, Description string
		Parameters        json.RawMessage
		ReadOnly          bool
		Risk              Risk
	}, 0, len(list))
	for _, t := range list {
		out = append(out, struct {
			Name, Description string
			Parameters        json.RawMessage
			ReadOnly          bool
			Risk              Risk
		}{t.Name(), t.Description(), canonicalizeSchema(t.Schema()), t.ReadOnly(), t.Risk()})
	}
	return out
}

func canonicalizeSchema(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{"type":"object","properties":{}}`)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw
	}
	b, err := json.Marshal(v)
	if err != nil {
		return raw
	}
	return b
}

// ProviderSchemas converts registry tools into provider tool schemas.
func (r *Registry) ProviderSchemas() []struct {
	Name        string
	Description string
	Parameters  json.RawMessage
} {
	list := r.List()
	out := make([]struct {
		Name        string
		Description string
		Parameters  json.RawMessage
	}, 0, len(list))
	for _, t := range list {
		out = append(out, struct {
			Name        string
			Description string
			Parameters  json.RawMessage
		}{t.Name(), t.Description(), canonicalizeSchema(t.Schema())})
	}
	return out
}
