package mobile

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/link"
)

func call(t *testing.T, runtime *Runtime, route string, input any) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(input)
	var out struct {
		Status int            `json:"status"`
		Body   map[string]any `json:"body"`
	}
	if err := json.Unmarshal(runtime.Call(route, body), &out); err != nil {
		t.Fatal(err)
	}
	return out.Status, out.Body
}
func TestNativeRuntimeRealEnrolledHandshakeAndEncryptedFrame(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	peer := link.NewNode()
	const device = "apple-native-0001"
	peer.RegisterDeviceKey(device, link.JWKFromPublic(&key.PublicKey))
	peer.RequireEnrollment()
	peer.Dispatcher().Register(codec.KindSyncOp, func(ctx *link.FrameContext, frame *codec.Frame) (int, any, bool, error) {
		var value map[string]any
		if err := codec.Decode(frame.Body, &value); err != nil {
			return 0, nil, false, err
		}
		return codec.KindSyncAck, map[string]any{"ok": true, "op": value["op"], "sessionId": ctx.SessionID}, false, nil
	})
	server := httptest.NewServer(peer.Handler())
	defer server.Close()
	runtime := New()
	defer runtime.Close()
	status, hello := call(t, runtime, "/link/dial", map[string]any{"serverUrl": server.URL, "deviceId": device})
	if status != 200 || hello["pending"] != true {
		t.Fatalf("hello status %d: %#v", status, hello)
	}
	transcript, err := base64.RawURLEncoding.DecodeString(hello["transcript"].(string))
	if err != nil {
		t.Fatal(err)
	}
	proof, err := link.SignHandshakeProof(key, device, transcript)
	if err != nil {
		t.Fatal(err)
	}
	session := hello["sessionId"].(string)
	status, finished := call(t, runtime, "/link/dial/finish", map[string]any{"sessionId": session, "proof": proof})
	if status != 200 || finished["ok"] != true {
		t.Fatalf("finish: %d %#v", status, finished)
	}
	status, result := call(t, runtime, "/link/push", map[string]any{"sessionId": session, "peerUrl": server.URL, "kind": codec.KindSyncOp, "body": map[string]any{"op": "changes"}})
	if status != 200 || result["ackKind"] != float64(codec.KindSyncAck) {
		t.Fatalf("push: %d %#v", status, result)
	}
	ack := result["ack"].(map[string]any)
	if ack["sessionId"] != session || ack["op"] != "changes" {
		t.Fatalf("ack: %#v", ack)
	}
	runtime.Close()
	status, _ = call(t, runtime, "/link/push", map[string]any{})
	if status != 410 {
		t.Fatalf("closed runtime accepted operation: %d", status)
	}
}
func TestNativeRuntimeOnlyAllowsBoundedInitiatorOperations(t *testing.T) {
	runtime := New()
	defer runtime.Close()
	for _, route := range []string{"/handshake", "/mlkem/generate", "/link/stream", "/link/dial?evil=1"} {
		status, _ := call(t, runtime, route, map[string]any{})
		if status != 403 {
			t.Fatalf("forbidden %s: %d", route, status)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); runtime.Call("/link/push", []byte(`{}`)) }()
	}
	runtime.Close()
	wg.Wait()
	if !json.Valid(runtime.Call("/link/push", []byte(`not-json`))) {
		t.Fatal("non-json native error")
	}
}
