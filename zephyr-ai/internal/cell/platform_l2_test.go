package cell

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool/platform"
)

type fakeHost struct {
	gotReq *platform.CallRequest
	resp   any
	err    error
}

func (f *fakeHost) Call(ctx context.Context, req platform.CallRequest) (any, error) {
	cp := req
	f.gotReq = &cp
	return f.resp, f.err
}

func TestPlatformL2BackendExecSuccess(t *testing.T) {
	host := &fakeHost{resp: map[string]any{
		"ok":       true,
		"exitCode": 0,
		"stdout":   "hello",
	}}
	b := &PlatformL2Backend{Host: host, UserID: "u1", SessionID: "s1", RunID: "r1", DatabaseGeneration: "g1", RunNonce: "n1"}

	res, err := b.Exec(context.Background(), "cell1", ExecRequest{Command: "grep", Args: []string{"foo", "bar"}})
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if res.Warning != "backend:legacy-l2" || res.Backend != "legacy-l2" {
		t.Fatalf("warning/backend not set: %+v", res)
	}
	if res.Stdout != "hello" {
		t.Fatalf("stdout %q", res.Stdout)
	}
	if host.gotReq.Tool != "session_exec_v1" {
		t.Fatalf("tool %q", host.gotReq.Tool)
	}
	var args map[string]any
	if err := json.Unmarshal(host.gotReq.Args, &args); err != nil {
		t.Fatal(err)
	}
	if args["command"] != "grep" {
		t.Fatalf("args %v", args)
	}
	if host.gotReq.UserID != "u1" || host.gotReq.SessionID != "s1" || host.gotReq.RunID != "r1" {
		t.Fatalf("identity not propagated: %+v", host.gotReq)
	}
	if host.gotReq.DatabaseGeneration != "g1" || host.gotReq.RunNonce != "n1" {
		t.Fatalf("nonce/gen not propagated: %+v", host.gotReq)
	}
}

func TestPlatformL2BackendExecFailure(t *testing.T) {
	host := &fakeHost{resp: map[string]any{
		"ok":   false,
		"code": "command_not_allowed",
		"error": "grep not in whitelist",
	}}
	b := &PlatformL2Backend{Host: host, SessionID: "s1"}

	res, err := b.Exec(context.Background(), "cell1", ExecRequest{Command: "rm"})
	if err == nil {
		t.Fatalf("expected error")
	}
	if res.Warning != "backend:legacy-l2" {
		t.Fatalf("warning %q", res.Warning)
	}
	var l2err interface{ Error() string }
	if !errors.As(err, &l2err) {
		t.Fatal("err must be error")
	}
}

func TestPlatformL2BackendHostNil(t *testing.T) {
	b := &PlatformL2Backend{}
	if _, err := b.Exec(context.Background(), "cell1", ExecRequest{Command: "grep"}); err == nil {
		t.Fatal("expected not-configured error")
	}
}

func TestPlatformL2BackendWriteUnsupported(t *testing.T) {
	b := &PlatformL2Backend{Host: &fakeHost{}}
	if _, err := b.Write(context.Background(), "cell1", WriteRequest{Path: "x", Content: "y"}); !errors.Is(err, ErrCellUnavailable) {
		t.Fatalf("write must be unavailable, got %v", err)
	}
	if b.IsDirectAvailable() {
		t.Fatal("direct must be unavailable")
	}
}

func TestServerRegisteredCellToolExecutesViaL2(t *testing.T) {
	// End-to-end: adapter + lease + platform L2 backend + AsExecTool path.
	host := &fakeHost{resp: map[string]any{
		"ok":       true,
		"exitCode": 0,
		"stdout":   "ok",
	}}
	adapter := NewWorkspaceAdapter(&PlatformL2Backend{Host: host, SessionID: "s1"})
	adapter.IssueLease("run_x", "conv_1", "binding_1", "local", time.Minute)
	tool := adapter.AsExecTool("run_x")

	out, err := tool.Execute(context.Background(), json.RawMessage(`{"command":"grep","args":["x"]}`))
	if err != nil {
		t.Fatalf("tool execute: %v", err)
	}
	res, ok := out.(ExecResult)
	if !ok {
		t.Fatalf("result type %T", out)
	}
	if res.Warning != "backend:legacy-l2" || res.Backend != "legacy-l2" {
		t.Fatalf("spec 6.1 warning missing: %+v", res)
	}
}

func TestServerRegisteredCellToolLeaseRejected(t *testing.T) {
	// No lease issued: tool must fail closed, never reach the backend.
	host := &fakeHost{}
	adapter := NewWorkspaceAdapter(&PlatformL2Backend{Host: host})
	tool := adapter.AsExecTool("run_unknown")
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"command":"grep"}`)); err == nil {
		t.Fatal("must reject exec without lease")
	}
	if host.gotReq != nil {
		t.Fatal("backend must not have been called")
	}
}