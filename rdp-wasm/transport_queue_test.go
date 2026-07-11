package main

import (
	"bytes"
	"testing"
)

func TestByteQueuePreservesOrderAcrossPartialReads(t *testing.T) {
	q := newByteQueue(64)
	if _, ok := q.Push([]byte{1, 2, 3}); !ok {
		t.Fatal("first push rejected")
	}
	if _, ok := q.Push([]byte{4, 5}); !ok {
		t.Fatal("second push rejected")
	}
	var got []byte
	buf := make([]byte, 2)
	for len(got) < 5 {
		n, closed := q.Read(buf)
		if closed {
			t.Fatal("queue closed early")
		}
		got = append(got, buf[:n]...)
	}
	if !bytes.Equal(got, []byte{1, 2, 3, 4, 5}) {
		t.Fatalf("unexpected order: %v", got)
	}
	state := q.State()
	if state.QueuedBytes != 0 || state.QueuedChunks != 0 {
		t.Fatalf("queue did not drain: %+v", state)
	}
}

func TestByteQueueRejectsBeforeHardLimitOverflow(t *testing.T) {
	q := newByteQueue(4)
	if _, ok := q.Push([]byte{1, 2, 3}); !ok {
		t.Fatal("initial push rejected")
	}
	state, ok := q.Push([]byte{4, 5})
	if ok {
		t.Fatal("overflow push must fail")
	}
	if state.QueuedBytes != 3 {
		t.Fatalf("overflow changed queue: %+v", state)
	}
	buf := make([]byte, 4)
	n, _ := q.Read(buf)
	if !bytes.Equal(buf[:n], []byte{1, 2, 3}) {
		t.Fatalf("accepted bytes were corrupted: %v", buf[:n])
	}
}

func TestByteQueueCloseWakesReaderAndDrainsAcceptedBytes(t *testing.T) {
	q := newByteQueue(16)
	q.Push([]byte{9})
	q.Close()
	buf := make([]byte, 1)
	n, closed := q.Read(buf)
	if n != 1 || closed {
		t.Fatalf("accepted byte not drained: n=%d closed=%v", n, closed)
	}
	n, closed = q.Read(buf)
	if n != 0 || !closed {
		t.Fatalf("closed empty queue not reported: n=%d closed=%v", n, closed)
	}
}
