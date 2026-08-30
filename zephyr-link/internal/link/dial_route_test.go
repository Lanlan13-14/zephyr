package link

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// An embedded node dials a server node through the loopback /link/dial route,
// exactly the path the Android Kotlin client drives.
func TestEmbeddedDialRoute(t *testing.T) {
	server := httptest.NewServer(NewNode().Handler())
	defer server.Close()

	device := NewNode()
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	body, _ := json.Marshal(map[string]any{"serverUrl": server.URL})
	resp, err := http.Post(deviceSrv.URL+"/link/dial", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out["ok"] != true || out["sessionId"] == "" {
		t.Fatalf("dial failed: %v", out)
	}
	// The device node now holds the session and can exchange frames with the server.
	sid := out["sessionId"].(string)
	device.mu.Lock()
	ep := device.sessions[sid]
	device.mu.Unlock()
	if ep == nil {
		t.Fatal("device did not retain the dialed session")
	}
	env, err := ep.Send(1, map[string]any{"hello": "server"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if env == nil || len(env.CT) == 0 {
		t.Fatal("no sealed envelope produced")
	}
}

func TestEmbeddedDialRouteHonoursPinnedSPKI(t *testing.T) {
	serverNode := NewNode()
	server := httptest.NewTLSServer(serverNode.Handler())
	defer server.Close()
	cert := server.Certificate()
	digest := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	pin := "sha256/" + base64.StdEncoding.EncodeToString(digest[:])

	device := NewNode()
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	call := func(pins []string) (int, map[string]any) {
		body, _ := json.Marshal(map[string]any{
			"serverUrl": server.URL, "deviceId": "device-pinned",
			"spkiPins": pins,
		})
		resp, err := http.Post(deviceSrv.URL+"/link/dial", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	status, out := call([]string{pin})
	if status != http.StatusOK || out["ok"] != true {
		t.Fatalf("correct pin failed: %d %#v", status, out)
	}
	status, _ = call([]string{"sha256/" + base64.StdEncoding.EncodeToString(make([]byte, 32))})
	if status != http.StatusBadGateway {
		t.Fatalf("wrong pin must fail closed, got %d", status)
	}
}

func TestEmbeddedDialRouteInsecureTrustsUnpinnedTLS(t *testing.T) {
	serverNode := NewNode()
	server := httptest.NewTLSServer(serverNode.Handler())
	defer server.Close()

	device := NewNode()
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	call := func(insecure bool) (int, map[string]any) {
		body, _ := json.Marshal(map[string]any{
			"serverUrl": server.URL, "deviceId": "device-insecure",
			"insecure": insecure,
		})
		resp, err := http.Post(deviceSrv.URL+"/link/dial", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	status, _ := call(false)
	if status != http.StatusBadGateway {
		t.Fatalf("unpinned TLS without insecure must fail closed, got %d", status)
	}
	status, out := call(true)
	if status != http.StatusOK || out["ok"] != true {
		t.Fatalf("insecure dial failed: %d %#v", status, out)
	}
}
