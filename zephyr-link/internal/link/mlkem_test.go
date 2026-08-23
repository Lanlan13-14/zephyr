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

// ML-KEM loopback endpoints: generate/encapsulate/decapsulate must agree with
// the raw primitives and with each other. This is the runnable proof that an
// embedded host can drive device identity without the host language ever
// touching the primitive.
func TestMlkemLoopbackEndpoints(t *testing.T) {
	n := NewNode()
	srv := httptest.NewServer(n.Handler())
	defer srv.Close()

	post := func(path string, body any) map[string]any {
		t.Helper()
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s: %v", path, err)
		}
		resp, err := http.Post(srv.URL+path, "application/json", bytes.NewReader(buf))
		if err != nil {
			t.Fatalf("post %s: %v", path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		return out
	}

	b64 := func(s string) []byte {
		t.Helper()
		raw, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			t.Fatalf("b64 decode: %v", err)
		}
		return raw
	}

	// 1) generate
	gen := post("/link/mlkem/generate", map[string]any{})
	if gen["ok"] != true {
		t.Fatalf("generate: %v", gen)
	}
	publicKey := b64(gen["publicKey"].(string))
	seed := b64(gen["seed"].(string))
	if len(publicKey) != zsl.MLKEM768PublicKeyBytes {
		t.Fatalf("public key %d bytes", len(publicKey))
	}
	if len(seed) != 64 {
		t.Fatalf("seed %d bytes", len(seed))
	}

	// 2) encapsulate
	enc := post("/link/mlkem/encapsulate", map[string]any{
		"publicKey": base64.RawURLEncoding.EncodeToString(publicKey),
	})
	if enc["ok"] != true {
		t.Fatalf("encapsulate: %v", enc)
	}
	sharedEnc := b64(enc["shared"].(string))
	ciphertext := b64(enc["ciphertext"].(string))
	if len(ciphertext) != zsl.MLKEM768CiphertextBytes {
		t.Fatalf("ciphertext %d bytes", len(ciphertext))
	}

	// 3) decapsulate — the seed must recover the same shared secret.
	dec := post("/link/mlkem/decapsulate", map[string]any{
		"seed":       base64.RawURLEncoding.EncodeToString(seed),
		"ciphertext": base64.RawURLEncoding.EncodeToString(ciphertext),
	})
	if dec["ok"] != true {
		t.Fatalf("decapsulate: %v", dec)
	}
	sharedDec := b64(dec["shared"].(string))
	if !bytes.Equal(sharedEnc, sharedDec) {
		t.Fatal("encapsulate/decapsulate shared secret mismatch")
	}

	// Negative: a bad-size public key must be rejected, not panic or mint garbage.
	bad := post("/link/mlkem/encapsulate", map[string]any{
		"publicKey": base64.RawURLEncoding.EncodeToString([]byte("short")),
	})
	if bad["ok"] != false {
		t.Fatalf("expected failure for short key, got %v", bad)
	}

	// Negative: a bad-size ciphertext must be rejected.
	badCt := post("/link/mlkem/decapsulate", map[string]any{
		"seed":       base64.RawURLEncoding.EncodeToString(seed),
		"ciphertext": base64.RawURLEncoding.EncodeToString([]byte("short")),
	})
	if badCt["ok"] != false {
		t.Fatalf("expected failure for short ciphertext, got %v", badCt)
	}
}
