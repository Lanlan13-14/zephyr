package zsl

import (
	"bytes"
	"testing"
)

func TestCloseClearsRetainedKeysAndPermanentlyRejectsUse(t *testing.T) {
	init, err := HandshakeInitiator()
	if err != nil {
		t.Fatal(err)
	}
	hello, peer, err := HandshakeResponder(init.X25519Public, init.MLKEMPublic)
	if err != nil {
		t.Fatal(err)
	}
	session, err := init.HandshakeFinish(hello)
	if err != nil {
		t.Fatal(err)
	}
	transcript := bytes.Repeat([]byte{9}, 32)
	if err := session.BindTranscript(transcript); err != nil {
		t.Fatal(err)
	}
	master, send, recv, exporter := session.master, session.sendKey, session.recvKey, session.exporter
	frame, err := peer.Seal([]byte("pending"))
	if err != nil {
		t.Fatal(err)
	}
	session.Close()
	session.Close()
	for _, key := range [][]byte{master, send, recv, exporter} {
		for _, b := range key {
			if b != 0 {
				t.Fatal("retained key bytes survived Close")
			}
		}
	}
	if session.Bound() || len(session.Exporter()) != 0 {
		t.Fatal("closed session still exposed binding")
	}
	if _, err := session.Seal([]byte("new")); err == nil {
		t.Fatal("closed seal accepted")
	}
	if _, err := session.Open(frame); err == nil {
		t.Fatal("closed open accepted")
	}
	if err := session.BindTranscript(transcript); err == nil {
		t.Fatal("closed session rebound")
	}
}
