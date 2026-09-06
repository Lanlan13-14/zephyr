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
func TestNormalizeCBORPreservesFalseHasMoreOnEmptyPage(t *testing.T) {
	page := map[string]any{
		"ok":         true,
		"fromCursor": int64(53),
		"nextCursor": int64(53),
		"hasMore":    false,
		"changes":    []any{},
	}
	normalized, err := normalizeCBORForJSON(page)
	if err != nil {
		t.Fatal(err)
	}
	root := normalized.(map[string]any)
	if root["hasMore"] != false {
		t.Fatalf("empty page lost hasMore=false: %#v", root["hasMore"])
	}
	if _, ok := root["changes"]; !ok {
		t.Fatal("empty page dropped changes")
	}
}

func TestNormalizeJSONNumbersKeepsFiniteFloats(t *testing.T) {
	raw := []byte(`{
		"serverCursor": 42,
		"revision": 1,
		"rdpTouchSensitivity": 1.5,
		"nested": {"rdpFps": 30, "ratio": 0.25},
		"list": [1, 2.5, 3]
	}`)
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	normalized, err := normalizeJSONIntegers(decoded)
	if err != nil {
		t.Fatal(err)
	}
	root := normalized.(map[string]any)
	if root["serverCursor"] != int64(42) {
		t.Fatalf("cursor lost integer identity: %#v", root["serverCursor"])
	}
	if root["rdpTouchSensitivity"] != 1.5 {
		t.Fatalf("connection float was dropped: %#v", root["rdpTouchSensitivity"])
	}
	nested := root["nested"].(map[string]any)
	if nested["rdpFps"] != int64(30) || nested["ratio"] != 0.25 {
		t.Fatalf("nested numbers not preserved: %#v", nested)
	}
	list := root["list"].([]any)
	if list[0] != int64(1) || list[1] != 2.5 || list[2] != int64(3) {
		t.Fatalf("array numbers not preserved: %#v", list)
	}
}

func TestNormalizeJSONNumbersRejectsNonFinite(t *testing.T) {
	for _, raw := range []string{`{"x": NaN}`, `{"x": Infinity}`, `{"x": -Infinity}`} {
		var decoded any
		decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			continue
		}
		if _, err := normalizeJSONIntegers(decoded); err == nil {
			t.Fatalf("expected non-finite rejection for %s", raw)
		}
	}
}

func TestSyncBridgeCarriesBusinessFrames(t *testing.T) {
	// A fake Node sync bridge: asserts the loopback token + attested device, then
	// returns a result the way the real sync core would.
	var gotDevice, gotToken string
	var gotBody map[string]any
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Link-Admin")
		var req syncBridgeRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotDevice = req.DeviceID
		gotBody, _ = req.Body.(map[string]any)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":   true,
			"kind": codec.KindSyncAck,
			"body": map[string]any{
				"batchId": "b1", "serverCursor": 42, "lastError": nil,
				"rdpTouchSensitivity": 1.5,
			},
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
	if gotBody["batchId"] != "b1" {
		t.Fatalf("bridge lost decoded business body: %#v", gotBody)
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
	if body["serverCursor"] != uint64(42) || body["lastError"] != nil {
		t.Fatalf("business result not carried back: %+v", body)
	}
	if body["rdpTouchSensitivity"] != 1.5 {
		t.Fatalf("connection float did not survive the Link ack: %+v", body["rdpTouchSensitivity"])
	}
}

func TestSyncBridgeReturnsStructuredBusinessError(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGone)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": false,
			"error": map[string]any{
				"code": "cursor_expired", "message": "bootstrap required",
				"retryable": false, "details": map[string]any{"bootstrapRequired": true},
			},
		})
	}))
	defer bridge.Close()

	node := NewNode()
	node.RegisterDevice("dev-expired")
	node.RegisterSyncBridge(SyncBridgeConfig{URL: bridge.URL, AdminToken: "tok-1234567890abcdef"})
	srv := httptest.NewServer(node.Handler())
	defer srv.Close()

	init, _ := zsl.HandshakeInitiator()
	hsBody, _ := json.Marshal(map[string]any{
		"deviceId":     "dev-expired",
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	hsResp, err := http.Post(srv.URL+"/link/handshake", "application/json", bytes.NewReader(hsBody))
	if err != nil {
		t.Fatal(err)
	}
	defer hsResp.Body.Close()
	var hs struct{ SessionID, X25519Public, MLKEMCiphertext string }
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
	env, err := ep.Send(codec.KindSyncOp, map[string]any{"op": "changes", "sinceCursor": 0}, false)
	if err != nil {
		t.Fatal(err)
	}
	frBody, _ := json.Marshal(map[string]any{
		"sessionId": hs.SessionID, "seq": env.Seq,
		"iv":  base64.RawURLEncoding.EncodeToString(env.IV),
		"ct":  base64.RawURLEncoding.EncodeToString(env.CT),
		"tag": base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	resp, err := http.Post(srv.URL+"/link/frame", "application/json", bytes.NewReader(frBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out frameResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Error != "" || out.CT == "" {
		t.Fatalf("business rejection must be an encrypted ACK, not plaintext: %+v", out)
	}
	iv, _ := base64.RawURLEncoding.DecodeString(out.IV)
	ct, _ := base64.RawURLEncoding.DecodeString(out.CT)
	tag, _ := base64.RawURLEncoding.DecodeString(out.Tag)
	ackFrame, err := ep.Receive(&Envelope{Seq: out.Seq, IV: iv, CT: ct, Tag: tag})
	if err != nil {
		t.Fatal(err)
	}
	if ackFrame.Kind != codec.KindSyncAck {
		t.Fatalf("expected SYNC_ACK, got %d", ackFrame.Kind)
	}
	var ackBody struct {
		OK    bool `cbor:"ok"`
		Error struct {
			Code      string         `cbor:"code"`
			Retryable bool           `cbor:"retryable"`
			Details   map[string]any `cbor:"details"`
		} `cbor:"error"`
	}
	if err := codec.Decode(ackFrame.Body, &ackBody); err != nil {
		t.Fatal(err)
	}
	if ackBody.OK || ackBody.Error.Code != "cursor_expired" || ackBody.Error.Retryable {
		t.Fatalf("business error semantics lost: %+v", ackBody)
	}
	if ackBody.Error.Details["bootstrapRequired"] != true {
		t.Fatalf("details lost: %+v", ackBody.Error.Details)
	}
}
