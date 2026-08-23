package link

import (
	"bytes"
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
