package link

import (
	"crypto/sha1"
	"encoding/base64"
	"strings"
	"testing"
)

func TestNewWSClientKeyMatchesNodeWsRegex(t *testing.T) {
	// Node's `ws` library: keyRegex = /^[+/0-9A-Za-z]{22}==$/
	for i := 0; i < 32; i++ {
		key, err := newWSClientKey()
		if err != nil {
			t.Fatal(err)
		}
		if len(key) != 24 || !strings.HasSuffix(key, "==") {
			t.Fatalf("key %q is not 24-char padded standard base64", key)
		}
		raw, err := base64.StdEncoding.DecodeString(key)
		if err != nil || len(raw) != 16 {
			t.Fatalf("key %q does not decode to 16 bytes: %v", key, err)
		}
		for _, c := range key[:22] {
			ok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/'
			if !ok {
				t.Fatalf("key %q has a character Node's ws would reject: %q", key, c)
			}
		}
	}
}

func TestLegacyGoStyleKeyWouldFailNodeWsRegex(t *testing.T) {
	legacy := "zephyr-link-1234567890"
	if validSecWebSocketKey(legacy) {
		t.Fatalf("legacy key %q must not be accepted", legacy)
	}
}

func TestWsAcceptIsStandardBase64NotRawURL(t *testing.T) {
	key := "dGhlIHNhbXBsZSBub25jZQ==" // RFC 6455 example
	got := wsAccept(key)
	sum := sha1.Sum([]byte(key + wsMagic))
	wantStd := base64.StdEncoding.EncodeToString(sum[:])
	wantRaw := base64.RawURLEncoding.EncodeToString(sum[:])
	if got != wantStd {
		t.Fatalf("wsAccept = %q, want RFC standard %q", got, wantStd)
	}
	if got == wantRaw && wantRaw != wantStd {
		t.Fatal("wsAccept still uses RawURLEncoding; Node's ws client will reject it")
	}
	// RFC 6455 §1.3 example: the Accept for this key is this exact string.
	if got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("wsAccept drifted from the RFC example: %q", got)
	}
}
