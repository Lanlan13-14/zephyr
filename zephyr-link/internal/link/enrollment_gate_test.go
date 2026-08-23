package link

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

// A server with enrollment required must reject a handshake from a device that
// never completed enrollment, and accept one that did. The ZSL keys are real so
// the size checks pass and only the enrollment gate decides.
func TestHandshakeEnrollmentGate(t *testing.T) {
	server := NewNode()
	server.RequireEnrollment()
	server.RegisterDevice("enrolled-device-0001")
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	init, err := zsl.HandshakeInitiator()
	if err != nil {
		t.Fatal(err)
	}
	post := func(deviceID string) int {
		body, _ := json.Marshal(map[string]any{
			"deviceId":     deviceID,
			"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
			"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
		})
		resp, err := http.Post(srv.URL+"/link/handshake", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := post("unenrolled-device-9999"); got != http.StatusForbidden {
		t.Fatalf("unenrolled device: got %d, want 403", got)
	}
	if got := post("enrolled-device-0001"); got != http.StatusOK {
		t.Fatalf("enrolled device: got %d, want 200", got)
	}
}

// A malformed KEM key is rejected with 400 before the enrollment lookup, so the
// size check cannot be used to distinguish enrolled from unknown devices.
func TestHandshakeSizeCheckedBeforeEnrollment(t *testing.T) {
	server := NewNode()
	server.RequireEnrollment()
	server.RegisterDevice("enrolled-device-0001")
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{
		"deviceId":     "enrolled-device-0001",
		"x25519Public": base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(make([]byte, 10)), // wrong size
	})
	resp, err := http.Post(srv.URL+"/link/handshake", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed key: got %d, want 400 (not an enrollment oracle)", resp.StatusCode)
	}
}
