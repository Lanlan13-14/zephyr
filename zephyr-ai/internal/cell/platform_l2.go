package cell

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool/platform"
)

// PlatformL2Call is the narrow slice of the platform host the legacy L2
// fallback needs. platform.Host satisfies it.
type PlatformL2Call interface {
	Call(ctx context.Context, req platform.CallRequest) (any, error)
}

// PlatformL2Backend routes Cell exec requests to the host's legacy L2
// engine (ai-session-exec.js session_exec_v1). Spec 6.1 phase one: unwired
// platforms fall back to Legacy L2 and every result carries
// warning=backend:legacy-l2.
type PlatformL2Backend struct {
	Host              PlatformL2Call
	UserID            string
	SessionID         string
	RunID             string
	DatabaseGeneration string
	RunNonce          string
	Context           json.RawMessage
	Confirmed         bool
}

// PlatformL2Result mirrors the session_exec_v1 tool payload.
type PlatformL2Result struct {
	OK       bool            `json:"ok"`
	Code     string          `json:"code,omitempty"`
	Error    string          `json:"error,omitempty"`
	ExitCode int             `json:"exitCode,omitempty"`
	Stdout   string          `json:"stdout,omitempty"`
	Stderr   string          `json:"stderr,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
}

func (b *PlatformL2Backend) Exec(ctx context.Context, cellID string, req ExecRequest) (ExecResult, error) {
	if b == nil || b.Host == nil {
		return ExecResult{}, fmt.Errorf("platform l2 backend not configured")
	}
	args, err := json.Marshal(map[string]any{
		"sessionId": b.SessionID,
		"command":  req.Command,
		"args":     req.Args,
		"timeoutMs": 120000,
	})
	if err != nil {
		return ExecResult{}, err
	}
	raw, err := b.Host.Call(ctx, platform.CallRequest{
		Tool:               "session_exec_v1",
		Args:               args,
		UserID:             b.UserID,
		SessionID:          b.SessionID,
		RunID:              b.RunID,
		DatabaseGeneration: b.DatabaseGeneration,
		RunNonce:           b.RunNonce,
		Context:            b.Context,
		Confirmed:          b.Confirmed,
	})
	if err != nil {
		return ExecResult{}, err
	}
	var res PlatformL2Result
	blob, _ := json.Marshal(raw)
	if err := json.Unmarshal(blob, &res); err != nil {
		return ExecResult{}, fmt.Errorf("legacy l2 decode: %w", err)
	}
	if !res.OK {
		return ExecResult{
			ExitCode: res.ExitCode,
			Stdout:   res.Stdout,
			Stderr:   res.Stderr,
			Warning:  "backend:legacy-l2",
			Backend:  "legacy-l2",
		}, fmt.Errorf("legacy l2: %s %s", res.Code, res.Error)
	}
	return ExecResult{
		ExitCode: res.ExitCode,
		Stdout:   res.Stdout,
		Stderr:   res.Stderr,
		Warning:  "backend:legacy-l2",
		Backend:  "legacy-l2",
	}, nil
}

// Write is not supported by the legacy L2 whitelist engine; the Cell direct
// engine is the only writer. Spec 6.1: fallback reports unavailable, never
// silently fabricates success.
func (b *PlatformL2Backend) Write(ctx context.Context, cellID string, req WriteRequest) (WriteResult, error) {
	return WriteResult{}, ErrCellUnavailable
}

func (b *PlatformL2Backend) IsDirectAvailable() bool {
	return false
}