package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/link"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

func authenticatedDevice(t *testing.T, node *link.Node, deviceID string) *ecdsa.PrivateKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	node.RegisterDeviceKey(deviceID, link.JWKFromPublic(&priv.PublicKey))
	return priv
}

func finishHello(t *testing.T, srvURL, deviceID string, priv *ecdsa.PrivateKey) (*link.Endpoint, string) {
	t.Helper()
	init, err := zsl.HandshakeInitiator()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"deviceId":     deviceID,
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	resp, err := http.Post(srvURL+"/link/handshake", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("hello: got %d", resp.StatusCode)
	}
	var hs struct {
		SessionID       string `json:"sessionId"`
		X25519Public    string `json:"x25519Public"`
		MLKEMCiphertext string `json:"mlkemCiphertext"`
		Challenge       string `json:"challenge"`
		Transcript      string `json:"transcript"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&hs); err != nil {
		t.Fatal(err)
	}
	xPub, _ := base64.RawURLEncoding.DecodeString(hs.X25519Public)
	kemCT, _ := base64.RawURLEncoding.DecodeString(hs.MLKEMCiphertext)
	challenge, _ := base64.RawURLEncoding.DecodeString(hs.Challenge)
	sess, err := init.HandshakeFinish(&zsl.ResponderHello{X25519Public: xPub, MLKEMCiphertext: kemCT})
	if err != nil {
		t.Fatal(err)
	}
	transcript := zsl.TranscriptHash(deviceID, init.X25519Public, init.MLKEMPublic, xPub, kemCT, challenge)
	proof, err := link.SignHandshakeProof(priv, deviceID, transcript)
	if err != nil {
		t.Fatal(err)
	}
	finishBody, _ := json.Marshal(map[string]any{"sessionId": hs.SessionID, "proof": proof})
	finish, err := http.Post(srvURL+"/link/handshake/finish", "application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatal(err)
	}
	finish.Body.Close()
	if finish.StatusCode != http.StatusOK {
		t.Fatalf("finish: got %d", finish.StatusCode)
	}
	if err := sess.BindTranscript(transcript); err != nil {
		t.Fatal(err)
	}
	return link.NewEndpoint(sess), hs.SessionID
}

// The full server-side path: enroll a device, handshake over the mounted /link
// routes, exchange a sealed frame. This is exactly what the Node front-end
// reverse-proxies to.
func TestServerLinkSurface(t *testing.T) {
	node := link.NewNode()
	node.RequireEnrollment()
	mux := http.NewServeMux()
	mux.Handle("/link/", node.Handler())
	srv := httptest.NewServer(mux)
	defer srv.Close()

	priv := authenticatedDevice(t, node, "device-under-test")
	// The server routes frames through its dispatcher; register the owned-sync
	// lane so the SYNC_OP below is dispatched (a real host wires this to the
	// account store). Without it the frame is correctly rejected.
	node.Dispatcher().Register(1 /* SYNC_OP */, func(ctx *link.FrameContext, fr *codec.Frame) (int, any, bool, error) {
		return 2 /* SYNC_ACK */, map[string]any{"receivedKind": fr.Kind, "ok": true}, false, nil
	})

	ep, sessionID := finishHello(t, srv.URL, "device-under-test", priv)

	// Exchange a sealed frame through the server's /link/frame route.
	env, err := ep.Send(1, map[string]any{"op": "upsert", "entity": "note"}, false)
	if err != nil {
		t.Fatal(err)
	}
	frameBody, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"seq":       env.Seq,
		"iv":        base64.RawURLEncoding.EncodeToString(env.IV),
		"ct":        base64.RawURLEncoding.EncodeToString(env.CT),
		"tag":       base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	fr, err := http.Post(srv.URL+"/link/frame", "application/json", bytes.NewReader(frameBody))
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
		t.Fatalf("frame rejected: %+v", ack)
	}
	// The device opens the server's sealed ack.
	aiv, _ := base64.RawURLEncoding.DecodeString(ack.IV)
	act, _ := base64.RawURLEncoding.DecodeString(ack.CT)
	atag, _ := base64.RawURLEncoding.DecodeString(ack.Tag)
	ackFrame, err := ep.Receive(&link.Envelope{Seq: ack.Seq, IV: aiv, CT: act, Tag: atag})
	if err != nil {
		t.Fatal(err)
	}
	if ackFrame.Kind != 2 {
		t.Fatalf("expected SYNC_ACK kind 2, got %d", ackFrame.Kind)
	}
}

// The enrollment gate holds on the mounted surface too.
func TestServerRejectsUnenrolled(t *testing.T) {
	node := link.NewNode()
	node.RequireEnrollment()
	mux := http.NewServeMux()
	mux.Handle("/link/", node.Handler())
	srv := httptest.NewServer(mux)
	defer srv.Close()

	init, _ := zsl.HandshakeInitiator()
	body, _ := json.Marshal(map[string]any{
		"deviceId":     "ghost-device",
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	resp, err := http.Post(srv.URL+"/link/handshake", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unenrolled device got %d, want 403", resp.StatusCode)
	}
}
