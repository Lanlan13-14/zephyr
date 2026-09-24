package cell

import (
	"context"
	"testing"
	"time"
)

func TestExecutionLeaseValidation(t *testing.T) {
	lease := &ExecutionLease{
		RunID:                 "r1",
		ConversationID:        "c1",
		BindingID:             "b1",
		CellAuthorityDeviceID: "device_local",
		LeaseEpoch:            1,
		ExpiresAt:             time.Now().Add(10 * time.Minute),
		IdempotencyKey:        "r1-1",
	}

	// 1. Same authority device succeeds
	if err := lease.Validate("device_local", 1); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}

	// 2. Different target device rejected to prevent split-brain
	if err := lease.Validate("device_remote", 1); err == nil {
		t.Fatalf("expected authority mismatch error, got nil")
	}

	// 3. Epoch mismatch rejected
	if err := lease.Validate("device_local", 2); err == nil {
		t.Fatalf("expected epoch conflict error, got nil")
	}

	// 4. Expired lease rejected
	expiredLease := &ExecutionLease{
		RunID:                 "r2",
		ConversationID:        "c2",
		BindingID:             "b2",
		CellAuthorityDeviceID: "device_local",
		LeaseEpoch:            1,
		ExpiresAt:             time.Now().Add(-1 * time.Second),
	}
	if err := expiredLease.Validate("device_local", 1); err != ErrLeaseExpired {
		t.Fatalf("expected ErrLeaseExpired, got: %v", err)
	}
}

func TestWorkspaceAdapterFallbackL2(t *testing.T) {
	// Adapter with mock L2 executor
	l2Exec := func(ctx context.Context, cmd string) (string, error) {
		return "hello from l2: " + cmd, nil
	}
	adapter := NewWorkspaceAdapter(&FallbackL2Backend{L2Executor: l2Exec})

	// Issue lease
	lease := adapter.IssueLease("run_100", "conv_1", "bind_1", "dev_a", 5*time.Minute)
	if lease == nil || lease.LeaseEpoch != 1 {
		t.Fatalf("unexpected lease: %+v", lease)
	}

	// Execute command under valid lease
	res, err := adapter.ExecuteCommand(context.Background(), "run_100", "dev_a", ExecRequest{
		Command: "uname -a",
	})
	if err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	if res.ExitCode != 0 {
		t.Fatalf("expected 0, got %d", res.ExitCode)
	}
	if res.Warning != "backend:legacy-l2" {
		t.Fatalf("expected backend:legacy-l2 warning, got: %s", res.Warning)
	}
	if res.Backend != "legacy-l2" {
		t.Fatalf("expected legacy-l2 backend, got: %s", res.Backend)
	}
	if res.Stdout != "hello from l2: uname -a" {
		t.Fatalf("unexpected stdout: %s", res.Stdout)
	}

	// Execute tool interface
	toolInst := adapter.AsExecTool("run_100")
	if toolInst.Name() != "cell_exec_v1" {
		t.Fatalf("unexpected tool name: %s", toolInst.Name())
	}
	out, err := toolInst.Execute(context.Background(), []byte(`{"command":"uname -a"}`))
	if err != nil {
		t.Fatalf("tool execute: %v", err)
	}
	res2, ok := out.(ExecResult)
	if !ok {
		t.Fatalf("tool result type %T", out)
	}
	if res2.ExitCode != 0 || res2.Stdout != "hello from l2: uname -a" {
		t.Fatalf("tool result %+v", res2)
	}
}
