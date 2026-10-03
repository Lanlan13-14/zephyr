package link

import (
	"bytes"
	"testing"
)

func TestZft2LaneReadPreservesRemainder(t *testing.T) {
	h := NewAgentTunnelHub(NewNode())
	lane := &Zft2Lane{hub: h, id: 1, in: make(chan []byte, 2), dead: make(chan struct{})}
	lane.in <- []byte("abcdef")
	first := make([]byte, 2)
	n, err := lane.Read(first)
	if err != nil || n != 2 || string(first) != "ab" {
		t.Fatalf("first read n=%d err=%v data=%q", n, err, first)
	}
	second := make([]byte, 4)
	n, err = lane.Read(second)
	if err != nil || n != 4 || string(second) != "cdef" {
		t.Fatalf("second read n=%d err=%v data=%q", n, err, second)
	}
}

func TestZft2LaneReadPreservesBinaryRemainder(t *testing.T) {
	h := NewAgentTunnelHub(NewNode())
	lane := &Zft2Lane{hub: h, id: 1, in: make(chan []byte, 2), dead: make(chan struct{})}
	payload := []byte{0, 1, 2, 3, 4}
	lane.in <- payload
	got := make([]byte, 0, len(payload))
	for i := 0; i < 3; i++ {
		p := make([]byte, 2)
		n, err := lane.Read(p)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, p[:n]...)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("got %v want %v", got, payload)
	}
}
