package link

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
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

type helloWire struct {
	OK              bool   `json:"ok"`
	SessionID       string `json:"sessionId"`
	X25519Public    string `json:"x25519Public"`
	MLKEMCiphertext string `json:"mlkemCiphertext"`
	Challenge       string `json:"challenge"`
	Transcript      string `json:"transcript"`
}

func mustKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func postJSON(t *testing.T, url string, body any) (*http.Response, []byte) {
	t.Helper()
	raw, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := new(bytes.Buffer)
	_, _ = out.ReadFrom(resp.Body)
	return resp, out.Bytes()
}

func completeAuthenticatedHandshake(t *testing.T, srvURL, deviceID string, priv *ecdsa.PrivateKey) (*zsl.Session, string) {
	t.Helper()
	init, err := zsl.HandshakeInitiator()
	if err != nil {
		t.Fatal(err)
	}
	resp, raw := postJSON(t, srvURL+"/link/handshake", map[string]any{
		"deviceId":     deviceID,
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("hello: %d %s", resp.StatusCode, raw)
	}
	var hello helloWire
	if err := json.Unmarshal(raw, &hello); err != nil {
		t.Fatal(err)
	}
	if hello.Challenge == "" || hello.Transcript == "" {
		t.Fatalf("enrolled hello omitted challenge: %s", raw)
	}
	xPub, _ := base64.RawURLEncoding.DecodeString(hello.X25519Public)
	kemCT, _ := base64.RawURLEncoding.DecodeString(hello.MLKEMCiphertext)
	challenge, _ := base64.RawURLEncoding.DecodeString(hello.Challenge)
	sess, err := init.HandshakeFinish(&zsl.ResponderHello{X25519Public: xPub, MLKEMCiphertext: kemCT})
	if err != nil {
		t.Fatal(err)
	}
	transcript := zsl.TranscriptHash(deviceID, init.X25519Public, init.MLKEMPublic, xPub, kemCT, challenge)
	claimed, _ := base64.RawURLEncoding.DecodeString(hello.Transcript)
	if !bytes.Equal(claimed, transcript) {
		t.Fatal("transcript mismatch")
	}
	proof, err := signHandshakeProof(priv, deviceID, transcript)
	if err != nil {
		t.Fatal(err)
	}
	finish, finishRaw := postJSON(t, srvURL+"/link/handshake/finish", map[string]any{
		"sessionId": hello.SessionID,
		"proof":     proof,
	})
	if finish.StatusCode != http.StatusOK {
		t.Fatalf("finish: %d %s", finish.StatusCode, finishRaw)
	}
	if err := sess.BindTranscript(transcript); err != nil {
		t.Fatal(err)
	}
	return sess, hello.SessionID
}

func TestHandshakeRequiresProofOnEnrolledNode(t *testing.T) {
	priv := mustKey(t)
	server := NewNode()
	server.RequireEnrollment()
	server.RegisterDeviceKey("dev-auth", jwkFromPublic(&priv.PublicKey))
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	init, _ := zsl.HandshakeInitiator()
	helloResp, helloRaw := postJSON(t, srv.URL+"/link/handshake", map[string]any{
		"deviceId":     "dev-auth",
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	if helloResp.StatusCode != http.StatusOK {
		t.Fatalf("hello: %d %s", helloResp.StatusCode, helloRaw)
	}
	var hello helloWire
	_ = json.Unmarshal(helloRaw, &hello)
	if hello.Challenge == "" {
		t.Fatal("challenge missing")
	}

	// A frame before finish must not ride a KEM-only session.
	xPub, _ := base64.RawURLEncoding.DecodeString(hello.X25519Public)
	kemCT, _ := base64.RawURLEncoding.DecodeString(hello.MLKEMCiphertext)
	sess, err := init.HandshakeFinish(&zsl.ResponderHello{X25519Public: xPub, MLKEMCiphertext: kemCT})
	if err != nil {
		t.Fatal(err)
	}
	ep := NewEndpoint(sess)
	env, err := ep.Send(1, map[string]any{"op": "x"}, false)
	if err != nil {
		t.Fatal(err)
	}
	frameRaw, _ := json.Marshal(map[string]any{
		"sessionId": hello.SessionID,
		"seq":       env.Seq,
		"iv":        base64.RawURLEncoding.EncodeToString(env.IV),
		"ct":        base64.RawURLEncoding.EncodeToString(env.CT),
		"tag":       base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	fr, err := http.Post(srv.URL+"/link/frame", "application/json", bytes.NewReader(frameRaw))
	if err != nil {
		t.Fatal(err)
	}
	fr.Body.Close()
	if fr.StatusCode == http.StatusOK {
		t.Fatal("unfinished handshake accepted a business frame")
	}

	wrong, _ := signHandshakeProof(mustKey(t), "dev-auth", make([]byte, 32))
	bad, badRaw := postJSON(t, srv.URL+"/link/handshake/finish", map[string]any{
		"sessionId": hello.SessionID, "proof": wrong,
	})
	if bad.StatusCode == http.StatusOK {
		t.Fatalf("wrong key accepted: %s", badRaw)
	}

	// The failed finish consumed the challenge. A later correct proof must also fail.
	transcript, _ := base64.RawURLEncoding.DecodeString(hello.Transcript)
	good, _ := signHandshakeProof(priv, "dev-auth", transcript)
	replay, replayRaw := postJSON(t, srv.URL+"/link/handshake/finish", map[string]any{
		"sessionId": hello.SessionID, "proof": good,
	})
	if replay.StatusCode == http.StatusOK {
		t.Fatalf("consumed challenge reused: %s", replayRaw)
	}
}

func TestHandshakeRejectsUnenrolledWithoutOracle(t *testing.T) {
	server := NewNode()
	server.RequireEnrollment()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	init, _ := zsl.HandshakeInitiator()
	resp, raw := postJSON(t, srv.URL+"/link/handshake", map[string]any{
		"deviceId":     "ghost",
		"x25519Public": base64.RawURLEncoding.EncodeToString(init.X25519Public),
		"mlkemPublic":  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unenrolled: %d %s", resp.StatusCode, raw)
	}
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	errObj, _ := body["error"].(map[string]any)
	if errObj["code"] != "device_not_enrolled" {
		t.Fatalf("code=%v", errObj["code"])
	}
}

func TestAuthenticatedHandshakeRoundTrip(t *testing.T) {
	priv := mustKey(t)
	server := NewNode()
	server.RequireEnrollment()
	server.RegisterDeviceKey("dev-ok", jwkFromPublic(&priv.PublicKey))
	server.Dispatcher().Register(codec.KindSyncOp, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		return codec.KindSyncAck, map[string]any{"ok": true}, false, nil
	})
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	sess, sessionID := completeAuthenticatedHandshake(t, srv.URL, "dev-ok", priv)
	ep := NewEndpoint(sess)
	env, err := ep.Send(1, map[string]any{"hello": "world"}, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"sessionId": sessionID,
		"seq":       env.Seq,
		"iv":        base64.RawURLEncoding.EncodeToString(env.IV),
		"ct":        base64.RawURLEncoding.EncodeToString(env.CT),
		"tag":       base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	resp, err := http.Post(srv.URL+"/link/frame", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("frame: %d", resp.StatusCode)
	}
}

func TestEmbeddedDialSignsWhenSignerInstalled(t *testing.T) {
	priv := mustKey(t)
	server := NewNode()
	server.RequireEnrollment()
	server.RegisterDeviceKey("dev-dial", jwkFromPublic(&priv.PublicKey))
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	device := NewNode()
	device.SetDeviceSigner("dev-dial", priv)
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	resp, raw := postJSON(t, deviceSrv.URL+"/link/dial", map[string]any{
		"serverUrl": srv.URL, "deviceId": "dev-dial",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dial: %d %s", resp.StatusCode, raw)
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out["ok"] != true || out["sessionId"] == "" || out["pending"] == true {
		t.Fatalf("expected completed dial, got %s", raw)
	}
}
