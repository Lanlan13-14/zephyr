package link

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

// The owned-sync lane end to end: a device dials, sends a SYNC_OP frame, the node
// forwards it to the loopback sync bridge (standing in for the Node sync core),
// and seals the bridge's result back as a SYNC_ACK. This proves the Link channel
// carries real business frames, not an echo.
func TestSyncBridgeCarriesBusinessFrames(t *testing.T) {
	// A fake Node sync bridge: asserts the loopback token + attested device, then
	// returns a result the way the real sync core would.
	var gotDevice, gotToken string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Link-Admin")
		var req syncBridgeRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotDevice = req.DeviceID
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":   true,
			"kind": codec.KindSyncAck,
			"body": map[string]any{"batchId": "b1", "serverCursor": 42},
		})
	}))
	defer bridge.Close()

	node := NewNode()
	node.RegisterDevice("dev-sync")
	node.RegisterSyncBridge(SyncBridgeConfig{URL: bridge.URL, AdminToken: "tok-1234567890abcdef"})
	srv := httptest.NewServer(node.Handler())
	defer srv.Close()

	// Device dials with a real ZSL/2 handshake.
	init, _ := zsl.HandshakeInitiator()
	hsBody, _ := json.Marshal(map[string]any{
		"deviceId":     "dev-sync",
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	hsResp, err := http.Post(srv.URL+"/link/handshake", "application/json", bytes.NewReader(hsBody))
	if err != nil {
		t.Fatal(err)
	}
	defer hsResp.Body.Close()
	var hs struct {
		SessionID       string `json:"sessionId"`
		X25519Public    string `json:"x25519Public"`
		MLKEMCiphertext string `json:"mlkemCiphertext"`
	}
	if err := json.NewDecoder(hsResp.Body).Decode(&hs); err != nil {
		t.Fatal(err)
	}
	xPub, _ := base64.RawURLEncoding.DecodeString(hs.X25519Public)
	kemCT, _ := base64.RawURLEncoding.DecodeString(hs.MLKEMCiphertext)
	sess, err := init.HandshakeFinish(&zsl.ResponderHello{X25519Public: xPub, MLKEMCiphertext: kemCT})
	if err != nil {
		t.Fatal(err)
	}
	ep := NewEndpoint(sess)

	// Push a SYNC_OP frame through the channel.
	env, err := ep.Send(codec.KindSyncOp, map[string]any{"operations": []any{}, "batchId": "b1"}, false)
	if err != nil {
		t.Fatal(err)
	}
	frBody, _ := json.Marshal(map[string]any{
		"sessionId": hs.SessionID,
		"seq":       env.Seq,
		"iv":        base64.RawURLEncoding.EncodeToString(env.IV),
		"ct":        base64.RawURLEncoding.EncodeToString(env.CT),
		"tag":       base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	fr, err := http.Post(srv.URL+"/link/frame", "application/json", bytes.NewReader(frBody))
	if err != nil {
		t.Fatal(err)
	}
	defer fr.Body.Close()
	var ack struct {
		OK  bool   `json:"ok"`
		Seq uint64 `json:"seq"`
		IV  string `json:"iv"`
		CT  string `json:"ct"`
		Tag string `json:"tag"`
	}
	if err := json.NewDecoder(fr.Body).Decode(&ack); err != nil {
		t.Fatal(err)
	}
	if !ack.OK {
		t.Fatalf("sync frame rejected")
	}

	// The bridge saw the session-attested device and the loopback token.
	if gotDevice != "dev-sync" {
		t.Fatalf("bridge saw device %q, want dev-sync", gotDevice)
	}
	if gotToken != "tok-1234567890abcdef" {
		t.Fatalf("bridge saw wrong admin token")
	}

	// The device opens the sealed SYNC_ACK carrying the business result.
	aiv, _ := base64.RawURLEncoding.DecodeString(ack.IV)
	act, _ := base64.RawURLEncoding.DecodeString(ack.CT)
	atag, _ := base64.RawURLEncoding.DecodeString(ack.Tag)
	ackFrame, err := ep.Receive(&Envelope{Seq: ack.Seq, IV: aiv, CT: act, Tag: atag})
	if err != nil {
		t.Fatal(err)
	}
	if ackFrame.Kind != codec.KindSyncAck {
		t.Fatalf("expected SYNC_ACK, got kind %d", ackFrame.Kind)
	}
	var body map[string]any
	if err := codec.Decode(ackFrame.Body, &body); err != nil {
		t.Fatalf("decode ack body: %v", err)
	}
	if body["serverCursor"] != float64(42) {
		t.Fatalf("business result not carried back: %+v", body)
	}
}

