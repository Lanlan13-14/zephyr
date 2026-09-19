package offload

import (
	"testing"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
)

func TestGateway_RegisterAndDispatch(t *testing.T) {
	var auditEntries []cell.AuditEntry
	gw := NewGateway(func(e cell.AuditEntry) { auditEntries = append(auditEntries, e) }, 100)

	gw.RegisterHandler("zc-device", func(req cell.OffloadRequest) cell.OffloadResult {
		return cell.OffloadResult{
			ExitCode: 0,
			Stdout:   `{"model":"test","os":"linux"}`,
		}
	})

	req := cell.OffloadRequest{
		Command:   "zc-device",
		Args:      []string{"--info"},
		SessionID: "sess-1",
	}
	result := gw.Dispatch(req, []string{"zc-device"})
	if result.ExitCode != 0 {
		t.Errorf("ExitCode: want 0, got %d", result.ExitCode)
	}
	if result.Stdout == "" {
		t.Error("Stdout should not be empty")
	}
	if len(auditEntries) != 1 {
		t.Errorf("audit entries: want 1, got %d", len(auditEntries))
	}
}

func TestGateway_WhitelistDeny(t *testing.T) {
	gw := NewGateway(nil, 100)
	gw.RegisterHandler("zc-calendar", func(_ cell.OffloadRequest) cell.OffloadResult {
		return cell.OffloadResult{ExitCode: 0}
	})

	// Not in whitelist
	result := gw.Dispatch(cell.OffloadRequest{Command: "zc-calendar", SessionID: "s1"}, []string{"zc-device"})
	if result.ExitCode != cell.OffloadExitUnavailable {
		t.Errorf("non-whitelisted: want exit %d, got %d", cell.OffloadExitUnavailable, result.ExitCode)
	}

	// Empty whitelist = all denied (default deny)
	result = gw.Dispatch(cell.OffloadRequest{Command: "zc-calendar", SessionID: "s1"}, nil)
	if result.ExitCode != cell.OffloadExitUnavailable {
		t.Errorf("empty whitelist: want exit %d, got %d", cell.OffloadExitUnavailable, result.ExitCode)
	}
}

func TestGateway_WildcardWhitelist(t *testing.T) {
	gw := NewGateway(nil, 100)
	gw.RegisterHandler("zc-device", func(_ cell.OffloadRequest) cell.OffloadResult {
		return cell.OffloadResult{ExitCode: 0}
	})

	result := gw.Dispatch(cell.OffloadRequest{Command: "zc-device", SessionID: "s1"}, []string{"*"})
	if result.ExitCode != 0 {
		t.Errorf("wildcard whitelist: want 0, got %d", result.ExitCode)
	}
}

func TestGateway_UnknownCommand(t *testing.T) {
	gw := NewGateway(nil, 100)

	result := gw.Dispatch(cell.OffloadRequest{Command: "zc-unknown", SessionID: "s1"}, []string{"*"})
	if result.ExitCode != cell.OffloadExitUnknown {
		t.Errorf("unknown command: want exit %d, got %d", cell.OffloadExitUnknown, result.ExitCode)
	}
}

func TestGateway_PermissionDenied(t *testing.T) {
	gw := NewGateway(nil, 100)
	gw.RegisterHandler("zc-photos", func(_ cell.OffloadRequest) cell.OffloadResult {
		return cell.OffloadResult{ExitCode: 0}
	})

	// Grant then revoke
	gw.GrantPermission("s1", "zc-photos")
	gw.RevokePermission("s1", "zc-photos")

	result := gw.Dispatch(cell.OffloadRequest{Command: "zc-photos", SessionID: "s1"}, []string{"zc-photos"})
	if result.ExitCode != cell.OffloadExitPermissionDenied {
		t.Errorf("revoked permission: want exit %d, got %d", cell.OffloadExitPermissionDenied, result.ExitCode)
	}
}

func TestGateway_OutputTruncation(t *testing.T) {
	gw := NewGateway(nil, 1) // 1KB max

	bigOutput := make([]byte, 5*1024)
	for i := range bigOutput {
		bigOutput[i] = 'X'
	}
	gw.RegisterHandler("zc-big", func(_ cell.OffloadRequest) cell.OffloadResult {
		return cell.OffloadResult{ExitCode: 0, Stdout: string(bigOutput)}
	})

	result := gw.Dispatch(cell.OffloadRequest{Command: "zc-big", SessionID: "s1"}, []string{"*"})
	if !result.Truncated {
		t.Error("output should be truncated")
	}
	if len(result.Stdout) > 1024 {
		t.Errorf("truncated output should be <= 1024, got %d", len(result.Stdout))
	}
	if len(result.Files) == 0 {
		t.Error("truncated output should have outbox file reference")
	}
}

// --- Wire protocol tests (§5.1) ---

func TestWireProtocol_Constants(t *testing.T) {
	if WireMagicRequest != 0x5a434646 {
		t.Errorf("WireMagicRequest: want 0x5a434646, got 0x%x", WireMagicRequest)
	}
	if WireMagicResponse != 0x5a434652 {
		t.Errorf("WireMagicResponse: want 0x5a434652, got 0x%x", WireMagicResponse)
	}
	if WireVersion != 1 {
		t.Errorf("WireVersion: want 1, got %d", WireVersion)
	}
	if WireSocketName != "zephyr-cell-offload" {
		t.Errorf("WireSocketName: want zephyr-cell-offload, got %s", WireSocketName)
	}
}

func TestWireProtocol_RequestRoundtrip(t *testing.T) {
	req := WireRequest{
		Magic:     WireMagicRequest,
		Version:   WireVersion,
		PID:       1234,
		SessionID: "sess-1",
		Command:   "zc-calendar",
		Args:      []string{"--list"},
		Cwd:       "/cell/workspace",
	}

	data, err := EncodeWireRequest(req)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	decoded, err := DecodeWireRequest(data)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if decoded.Magic != WireMagicRequest {
		t.Errorf("Magic: want 0x%x, got 0x%x", WireMagicRequest, decoded.Magic)
	}
	if decoded.Command != "zc-calendar" {
		t.Errorf("Command: want zc-calendar, got %s", decoded.Command)
	}
	if decoded.PID != 1234 {
		t.Errorf("PID: want 1234, got %d", decoded.PID)
	}
}

func TestWireProtocol_ResponseRoundtrip(t *testing.T) {
	resp := WireResponse{
		Magic:   WireMagicResponse,
		Version: WireVersion,
		Result: cell.OffloadResult{
			ExitCode: 0,
			Stdout:   "event created",
		},
	}

	data, err := EncodeWireResponse(resp)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	decoded, err := DecodeWireResponse(data)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if decoded.Magic != WireMagicResponse {
		t.Errorf("Magic mismatch")
	}
	if decoded.Result.ExitCode != 0 {
		t.Errorf("ExitCode: want 0, got %d", decoded.Result.ExitCode)
	}
}

func TestGateway_HasHandler(t *testing.T) {
	gw := NewGateway(nil, 100)
	gw.RegisterHandler("zc-device", func(_ cell.OffloadRequest) cell.OffloadResult {
		return cell.OffloadResult{ExitCode: 0}
	})

	if !gw.HasHandler("zc-device") {
		t.Error("should have zc-device handler")
	}
	if gw.HasHandler("zc-unknown") {
		t.Error("should not have zc-unknown handler")
	}
}
