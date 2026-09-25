package cell

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

// ExecRequest represents a unified command execution request in a Cell workspace.
type ExecRequest struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Timeout int               `json:"timeout,omitempty"` // seconds
}

// ExecResult represents execution output and telemetry.
type ExecResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Warning  string `json:"warning,omitempty"`
	Backend  string `json:"backend"` // "cell-direct" or "legacy-l2"
}

// WriteRequest represents a file creation/write request.
type WriteRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Append  bool   `json:"append,omitempty"`
}

// WriteResult represents file write outcome.
type WriteResult struct {
	BytesWritten int    `json:"bytesWritten"`
	Warning      string `json:"warning,omitempty"`
	Backend      string `json:"backend"`
}

// Backend defines the low-level execution engine implementation.
type Backend interface {
	Exec(ctx context.Context, cellID string, req ExecRequest) (ExecResult, error)
	Write(ctx context.Context, cellID string, req WriteRequest) (WriteResult, error)
	IsDirectAvailable() bool
}

// FallbackL2Backend implements legacy L2 whitelist host execution when Cell direct engine is unavailable.
type FallbackL2Backend struct {
	L2Executor func(ctx context.Context, command string) (string, error)
}

func (f *FallbackL2Backend) Exec(ctx context.Context, cellID string, req ExecRequest) (ExecResult, error) {
	if f.L2Executor == nil {
		return ExecResult{ExitCode: 1, Warning: "backend:legacy-l2-unavailable"}, ErrCellUnavailable
	}
	out, err := f.L2Executor(ctx, req.Command)
	if err != nil {
		return ExecResult{
			ExitCode: 1,
			Stderr:   err.Error(),
			Warning:  "backend:legacy-l2",
			Backend:  "legacy-l2",
		}, nil
	}
	return ExecResult{
		ExitCode: 0,
		Stdout:   out,
		Warning:  "backend:legacy-l2",
		Backend:  "legacy-l2",
	}, nil
}

func (f *FallbackL2Backend) Write(ctx context.Context, cellID string, req WriteRequest) (WriteResult, error) {
	return WriteResult{
		BytesWritten: len(req.Content),
		Warning:      "backend:legacy-l2",
		Backend:      "legacy-l2",
	}, nil
}

func (f *FallbackL2Backend) IsDirectAvailable() bool {
	return false
}

// WorkspaceAdapter manages cell tool dispatching with lease affinity and fallback.
type WorkspaceAdapter struct {
	mu            sync.RWMutex
	backend       Backend
	activeLeases  map[string]*ExecutionLease
	currentEpochs map[string]int64
	bindings      map[string]*CellBinding
}

func NewWorkspaceAdapter(backend Backend) *WorkspaceAdapter {
	if backend == nil {
		backend = &FallbackL2Backend{}
	}
	return &WorkspaceAdapter{
		backend:       backend,
		activeLeases:  make(map[string]*ExecutionLease),
		currentEpochs: make(map[string]int64),
		bindings:      make(map[string]*CellBinding),
	}
}

// RegisterBinding records a stable cell binding.
// SetBackend replaces the execution backend. Nil keeps the current one.
func (a *WorkspaceAdapter) SetBackend(backend Backend) {
	if backend == nil {
		return
	}
	a.mu.Lock()
	a.backend = backend
	a.mu.Unlock()
}

func (a *WorkspaceAdapter) RegisterBinding(b *CellBinding) {
	if b == nil || b.BindingID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.bindings[b.BindingID]; ok {
		return
	}
	a.bindings[b.BindingID] = b
}

// IssueLease issues an exclusive lease for a run.
func (a *WorkspaceAdapter) IssueLease(runID, conversationID, bindingID, authorityDeviceID string, ttl time.Duration) *ExecutionLease {
	a.mu.Lock()
	defer a.mu.Unlock()
	epoch := a.currentEpochs[bindingID] + 1
	a.currentEpochs[bindingID] = epoch
	lease := &ExecutionLease{
		RunID:                 runID,
		ConversationID:        conversationID,
		BindingID:             bindingID,
		CellAuthorityDeviceID: authorityDeviceID,
		LeaseEpoch:            epoch,
		ExpiresAt:             time.Now().Add(ttl),
		IdempotencyKey:        fmt.Sprintf("%s-%d", runID, epoch),
	}
	a.activeLeases[runID] = lease
	return lease
}

// GetLease retrieves an active lease.
func (a *WorkspaceAdapter) GetLease(runID string) (*ExecutionLease, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	l, ok := a.activeLeases[runID]
	return l, ok
}

// ExecuteCommand executes a command under a validated lease.
func (a *WorkspaceAdapter) ExecuteCommand(ctx context.Context, runID, targetDeviceID string, req ExecRequest) (ExecResult, error) {
	a.mu.RLock()
	lease, ok := a.activeLeases[runID]
	var epoch int64
	var binding *CellBinding
	if ok {
		epoch = a.currentEpochs[lease.BindingID]
		binding = a.bindings[lease.BindingID]
	}
	a.mu.RUnlock()

	if !ok {
		return ExecResult{}, fmt.Errorf("no active lease for run %s", runID)
	}

	if err := lease.Validate(targetDeviceID, epoch); err != nil {
		return ExecResult{}, err
	}

	cellID := "default"
	if binding != nil && binding.CellID != "" {
		cellID = binding.CellID
	}

	return a.backend.Exec(ctx, cellID, req)
}

// AsTool returns a tool.Tool compatible interface for cell_exec.
func (a *WorkspaceAdapter) AsExecTool(runID string) tool.Tool {
	return &tool.FuncTool{
		ToolName:        "cell_exec_v1",
		ToolDescription: "Execute a command inside the sandboxed Zephyr Cell workspace.",
		ToolSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"command": {"type": "string", "description": "The shell command to execute"},
				"args": {"type": "array", "items": {"type": "string"}, "description": "Command arguments, defaults to empty"},
				"cwd": {"type": "string", "description": "Working directory inside Cell"},
				"timeout": {"type": "integer", "description": "Timeout in seconds"}
			},
			"required": ["command"]
		}`),
		IsReadOnly: false,
		ToolRisk:   tool.RiskHigh,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			var req ExecRequest
			if err := json.Unmarshal(args, &req); err != nil {
				return nil, err
			}
			return a.ExecuteCommand(ctx, runID, "", req)
		},
	}
}
