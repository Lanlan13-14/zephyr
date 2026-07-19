package main

import (
	"strings"
	"testing"
	"time"
)

func TestRingBufferUnderCapacity(t *testing.T) {
	rb := NewRingBuffer(64)
	rb.Write("hello")
	rb.Write(" world")
	got := rb.Snapshot()
	if got != "hello world" {
		t.Fatalf("expected 'hello world', got %q", got)
	}
}

func TestRingBufferOverwritesOldest(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Write("0123456789") // exactly full
	if got := rb.Snapshot(); got != "0123456789" {
		t.Fatalf("full buffer mismatch: %q", got)
	}
	rb.Write("ABC") // should overwrite "012"
	if got := rb.Snapshot(); got != "3456789ABC" {
		t.Fatalf("after overwrite: %q", got)
	}
	rb.Write("DEFGHIJKLMNOP") // 13 bytes, larger than buffer
	// buffer keeps the last 10 bytes of the write
	if got := rb.Snapshot(); got != "GHIJKLMNOP" {
		t.Fatalf("after large overwrite: %q", got)
	}
}

func TestRingBufferWraparound(t *testing.T) {
	rb := NewRingBuffer(8)
	rb.Write("abcdefgh") // full, start=0
	rb.Write("XY")       // overwrites ab -> start=2
	if got := rb.Snapshot(); got != "cdefghXY" {
		t.Fatalf("wrap: %q", got)
	}
	rb.Write("Z12") // overwrites cde -> start=5
	if got := rb.Snapshot(); got != "fghXYZ12" {
		t.Fatalf("wrap2: %q", got)
	}
}

func TestRingBufferEmpty(t *testing.T) {
	rb := NewRingBuffer(16)
	if got := rb.Snapshot(); got != "" {
		t.Fatalf("empty: %q", got)
	}
}

func TestRingBufferLargeWriteExceedsBuffer(t *testing.T) {
	rb := NewRingBuffer(5)
	rb.Write(strings.Repeat("x", 100))
	got := rb.Snapshot()
	if len(got) != 5 {
		t.Fatalf("expected 5 bytes, got %d", len(got))
	}
	if got != "xxxxx" {
		t.Fatalf("expected 'xxxxx', got %q", got)
	}
}

func TestHashToken(t *testing.T) {
	a := hashToken("abc")
	b := hashToken("abc")
	c := hashToken("abd")
	if a != b {
		t.Fatal("same input must hash same")
	}
	if a == c {
		t.Fatal("different input must hash different")
	}
	if len(a) != 64 {
		t.Fatalf("sha256 hex length: %d", len(a))
	}
}

func TestRandomToken(t *testing.T) {
	a := randomToken()
	b := randomToken()
	if a == "" || b == "" {
		t.Fatal("empty token")
	}
	if a == b {
		t.Fatal("tokens must be unique")
	}
}

func TestSessionManagerBasics(t *testing.T) {
	store := NewSessionManager()
	s1 := &Session{ID: "s1", UserID: "u1"}
	store.Put(s1)
	if store.Get("s1") != s1 {
		t.Fatal("Get failed")
	}
	if store.Get("missing") != nil {
		t.Fatal("Get missing should be nil")
	}
	store.Delete("s1")
	if store.Get("s1") != nil {
		t.Fatal("Delete failed")
	}
}

func TestTicketStoreIssueConsume(t *testing.T) {
	ts := NewTicketStore()
	spec := HostSpec{Host: "h", Port: 22, Username: "u"}
	secrets := Secrets{Password: "p"}
	ticket := &Ticket{
		Token:     randomToken(),
		UserID:    "user1",
		ConnID:    "conn1",
		HostSpec:  spec,
		Secrets:   secrets,
		ExpiresAt: time.Now().Add(60 * time.Second),
	}
	ts.Issue(ticket)
	token := ticket.Token
	if token == "" {
		t.Fatal("empty token")
	}
	got, err := ts.Consume(token)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if got.UserID != "user1" || got.ConnID != "conn1" || got.Secrets.Password != "p" {
		t.Fatalf("consumed ticket mismatch: %+v", got)
	}
	// second consume must fail (one-shot)
	if _, err := ts.Consume(token); err == nil {
		t.Fatal("double consume must fail")
	}
	// wrong token
	if _, err := ts.Consume("garbage"); err == nil {
		t.Fatal("unknown token must fail")
	}
}

func TestEnvelopeJSONRoundTrip(t *testing.T) {
	e := Envelope{Type: "data", SessionID: "s1", Data: "hello"}
	b, err := jsonMarshal(e)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Envelope
	if err := jsonUnmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != "data" || got.Data != "hello" || got.SessionID != "s1" {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}
