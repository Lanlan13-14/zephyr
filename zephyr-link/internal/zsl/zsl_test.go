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

// keyVector mirrors the deterministic key-schedule JSON the Node reference emits.
type keyVector struct {
	Master   string `json:"master"`
	Role     string `json:"role"`
	SendKey  string `json:"sendKey"`
	RecvKey  string `json:"recvKey"`
	Exporter string `json:"exporter"`
}

// TestKeyScheduleVectors locks the deterministic half of ZSL/2: given a master,
// Go must derive the same send/recv/exporter keys as the Node reference. Frame
// sealing uses a random IV by design and is covered by the live round-trip tests
// above, not by a reproducibility-asserted file.
func TestKeyScheduleVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/keyschedule.json")
	if err != nil {
		t.Skip("no key-schedule vectors (run scripts/gen-zsl-vectors.mjs)")
	}
	var vectors []keyVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		master, _ := base64.StdEncoding.DecodeString(v.Master)
		sess := openSession(master, v.Role)
		if got := base64.StdEncoding.EncodeToString(sess.sendKey); got != v.SendKey {
			t.Fatalf("vector %d (%s): sendKey diverges", i, v.Role)
		}
		if got := base64.StdEncoding.EncodeToString(sess.recvKey); got != v.RecvKey {
			t.Fatalf("vector %d (%s): recvKey diverges", i, v.Role)
		}
		if got := base64.StdEncoding.EncodeToString(sess.Exporter()); got != v.Exporter {
			t.Fatalf("vector %d (%s): exporter diverges", i, v.Role)
		}
	}
}
