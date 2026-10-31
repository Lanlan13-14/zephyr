package link

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAIBridgeAuthenticatedSessionDispatchesRealBusinessRequest(t *testing.T) {
	t.Run("AI", func(t *testing.T) { testBusinessBridge(t, codec.KindAI) })
	t.Run("primary-PTY", func(t *testing.T) { testBusinessBridge(t, codec.KindSharedTerminal) })
}

func testBusinessBridge(t *testing.T, kind int) {
	calls := 0
	business := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("X-Link-Admin") != "test-bridge-secret-123456" {
			t.Error("missing bridge auth")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("bad bridge JSON")
		}
		if body["deviceId"] != "device-ai" || body["kind"] != float64(kind) {
			t.Errorf("identity from authenticated session: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "kind": kind, "body": map[string]any{"ok": true, "runId": "executed-run", "state": "running"}})
	}))
	defer business.Close()
	node := NewNode()
	var registerErr error
	if kind == codec.KindSharedTerminal {
		registerErr = node.RegisterPtyBridge(PtyBridgeConfig{URL: business.URL, AdminToken: "test-bridge-secret-123456"})
	} else {
		registerErr = node.RegisterAIBridge(AIBridgeConfig{URL: business.URL, AdminToken: "test-bridge-secret-123456"})
	}
	if registerErr != nil {
		t.Fatal(registerErr)
	}
	host := httptest.NewServer(node.Handler())
	defer host.Close()
	device, sessionID := enrollAndHandshake(t, node, host.URL, "device-ai")
	body := map[string]any{"op": "ai.command.dispatch", "requestId": "req1", "prompt": "pwd", "deviceId": "forged-device"}
	envelope, err := device.Send(kind, body, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"sessionId": sessionID, "seq": envelope.Seq,
		"iv": base64.RawURLEncoding.EncodeToString(envelope.IV), "ct": base64.RawURLEncoding.EncodeToString(envelope.CT), "tag": base64.RawURLEncoding.EncodeToString(envelope.Tag)})
	res, err := http.Post(host.URL+"/link/frame", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	reply, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("receive %d: %s", res.StatusCode, reply)
	}
	var sealed struct {
		Seq uint64 `json:"seq"`
		IV  string `json:"iv"`
		CT  string `json:"ct"`
		Tag string `json:"tag"`
	}
	if err := json.Unmarshal(reply, &sealed); err != nil {
		t.Fatal(err)
	}
	iv, _ := base64.RawURLEncoding.DecodeString(sealed.IV)
	ct, _ := base64.RawURLEncoding.DecodeString(sealed.CT)
	tag, _ := base64.RawURLEncoding.DecodeString(sealed.Tag)
	frame, err := device.Receive(&Envelope{Seq: sealed.Seq, IV: iv, CT: ct, Tag: tag})
	if err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := codec.Decode(frame.Body, &ack); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || frame.Kind != kind || ack["runId"] != "executed-run" {
		t.Fatalf("not real AI business result: calls=%d frame=%#v ack=%#v", calls, frame, ack)
	}
}

func TestAIBridgeRejectsNonLoopbackAndEmptyToken(t *testing.T) {
	for _, cfg := range []AIBridgeConfig{{URL: "https://example.invalid/internal", AdminToken: "test-bridge-secret-123456"}, {URL: "http://127.0.0.1:8080/internal"}} {
		if NewNode().RegisterAIBridge(cfg) == nil {
			t.Fatal("unsafe AI bridge accepted")
		}
	}
}
