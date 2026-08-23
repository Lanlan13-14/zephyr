package zsl

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

// Round-trip a full handshake between two in-process peers and exchange frames
// in both directions.
func TestHandshakeRoundTrip(t *testing.T) {
	init, err := HandshakeInitiator()
	if err != nil {
		t.Fatal(err)
	}
	hello, responder, err := HandshakeResponder(init.X25519Public, init.MLKEMPublic)
	if err != nil {
		t.Fatal(err)
	}
	initiator, err := init.HandshakeFinish(hello)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(initiator.Exporter(), responder.Exporter()) {
		t.Fatal("exporters differ: master keys diverged")
	}

	// initiator -> responder
	f, err := initiator.Seal([]byte("hello from device"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := responder.Open(f)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello from device" {
		t.Fatalf("unexpected plaintext %q", got)
	}

	// responder -> initiator
	back, err := responder.Seal([]byte("hello from server"))
	if err != nil {
		t.Fatal(err)
	}
	got2, err := initiator.Open(back)
	if err != nil {
		t.Fatal(err)
	}
	if string(got2) != "hello from server" {
		t.Fatalf("unexpected plaintext %q", got2)
	}
}

func TestReplayRejected(t *testing.T) {
	init, _ := HandshakeInitiator()
	hello, responder, _ := HandshakeResponder(init.X25519Public, init.MLKEMPublic)
	initiator, _ := init.HandshakeFinish(hello)

	f, _ := initiator.Seal([]byte("msg"))
	if _, err := responder.Open(f); err != nil {
		t.Fatal(err)
	}
	if _, err := responder.Open(f); err == nil {
		t.Fatal("replayed frame was accepted")
	}
}

func TestTamperedTagRejected(t *testing.T) {
	init, _ := HandshakeInitiator()
	hello, responder, _ := HandshakeResponder(init.X25519Public, init.MLKEMPublic)
	initiator, _ := init.HandshakeFinish(hello)

	f, _ := initiator.Seal([]byte("msg"))
	f.Tag[0] ^= 0xff
	if _, err := responder.Open(f); err == nil {
		t.Fatal("tampered frame was accepted")
	}
}

func TestBadKEMSizeFailsClosed(t *testing.T) {
	if _, _, err := HandshakeResponder(make([]byte, X25519Bytes), make([]byte, 8)); err == nil {
		t.Fatal("short ML-KEM key accepted")
	}
}

// vector mirrors the JSON the Node reference emits for interop testing.
type vector struct {
	Master       string `json:"master"`
	Role         string `json:"role"`
	Plaintext    string `json:"plaintext"`
	Seq          uint64 `json:"seq"`
	IV           string `json:"iv"`
	CT           string `json:"ct"`
	Tag          string `json:"tag"`
	ExpectOpenOK bool   `json:"expectOpenOk"`
}

// TestInteropVectors replays Node-generated seal vectors through the Go open
// path. The vector file is produced by scripts/gen-zsl-vectors.mjs; when absent
// the test is skipped so a pure-Go checkout still builds.
func TestInteropVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/interop.json")
	if err != nil {
		t.Skip("no interop vectors (run scripts/gen-zsl-vectors.mjs)")
	}
	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		master, _ := base64.StdEncoding.DecodeString(v.Master)
		iv, _ := base64.StdEncoding.DecodeString(v.IV)
		ct, _ := base64.StdEncoding.DecodeString(v.CT)
		tag, _ := base64.StdEncoding.DecodeString(v.Tag)
		// Rebuild the peer session directly from the shared master so we test the
		// wire format + key schedule, not the KEM (which is exercised above).
		var sess *Session
		if v.Role == "initiator" {
			// vector was sealed BY initiator, so we open as responder.
			sess = openSession(master, "responder")
		} else {
			sess = openSession(master, "initiator")
		}
		_, err := sess.Open(&Frame{Seq: v.Seq, IV: iv, CT: ct, Tag: tag})
		if v.ExpectOpenOK && err != nil {
			t.Fatalf("vector %d: open failed: %v", i, err)
		}
		if !v.ExpectOpenOK && err == nil {
			t.Fatalf("vector %d: expected open to fail", i)
		}
	}
}
