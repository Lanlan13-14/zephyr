package main

import (
	"bytes"
	"net"
	"sync"
	"testing"
	"time"
)

func TestTelnetFilterIACStripsOptions(t *testing.T) {
	// "hi" + IAC DO ECHO + "!" + IAC IAC + "x"
	in := []byte{0x68, 0x69, telnetIAC, telnetDO, telnetOptECHO, 0x21, telnetIAC, telnetIAC, 0x78}
	out := telnetFilterIAC(in)
	want := []byte{0x68, 0x69, 0x21, 0xff, 0x78}
	if !bytes.Equal(out, want) {
		t.Fatalf("got %v want %v", out, want)
	}
}

func TestTelnetIacEngineBuffersAcrossChunks(t *testing.T) {
	e := newTelnetIacEngine(nil, "xterm-256color")
	e.respond = false
	a := e.feed([]byte{0x41, telnetIAC})
	if !bytes.Equal(a, []byte{0x41}) {
		t.Fatalf("first: %v", a)
	}
	if len(e.pending) != 1 {
		t.Fatalf("pending len %d", len(e.pending))
	}
	b := e.feed([]byte{telnetDO, telnetOptECHO, 0x42})
	if !bytes.Equal(b, []byte{0x42}) {
		t.Fatalf("second: %v", b)
	}
}

func TestTelnetIacEngineAnswersTTYPE(t *testing.T) {
	var mu sync.Mutex
	var written []byte
	e := newTelnetIacEngine(func(b []byte) error {
		mu.Lock()
		written = append(written, b...)
		mu.Unlock()
		return nil
	}, "xterm-256color")

	chunk := []byte{
		telnetIAC, telnetSB, telnetOptTTYPE, telnetTTypeSEND, telnetIAC, telnetSE,
		0x68, 0x69,
	}
	out := e.feed(chunk)
	if !bytes.Equal(out, []byte{0x68, 0x69}) {
		t.Fatalf("payload %v", out)
	}
	mu.Lock()
	got := append([]byte{}, written...)
	mu.Unlock()
	want := append([]byte{telnetIAC, telnetSB, telnetOptTTYPE, telnetTTypeIS}, []byte("xterm-256color")...)
	want = append(want, telnetIAC, telnetSE)
	if !bytes.Equal(got, want) {
		t.Fatalf("ttype reply\ngot  %v\nwant %v", got, want)
	}
}

func TestTelnetIacEngineTTYPESplitBody(t *testing.T) {
	var written []byte
	e := newTelnetIacEngine(func(b []byte) error {
		written = append(written, b...)
		return nil
	}, "vt100")
	e.feed([]byte{telnetIAC, telnetSB, telnetOptTTYPE})
	e.feed([]byte{telnetTTypeSEND, telnetIAC})
	e.feed([]byte{telnetSE})
	want := append([]byte{telnetIAC, telnetSB, telnetOptTTYPE, telnetTTypeIS}, []byte("vt100")...)
	want = append(want, telnetIAC, telnetSE)
	if !bytes.Equal(written, want) {
		t.Fatalf("got %v want %v", written, want)
	}
}

func TestTelnetIacEngineOptionReplies(t *testing.T) {
	var written [][]byte
	e := newTelnetIacEngine(func(b []byte) error {
		written = append(written, append([]byte{}, b...))
		return nil
	}, "xterm-256color")
	// Force us NAWS off so DO NAWS elicits WILL
	e.us[telnetOptNAWS] = false
	e.feed([]byte{telnetIAC, telnetDO, telnetOptNAWS})
	if !e.us[telnetOptNAWS] {
		t.Fatal("us NAWS should be on")
	}
	if len(written) == 0 || !bytes.Equal(written[0], []byte{telnetIAC, telnetWILL, telnetOptNAWS}) {
		t.Fatalf("WILL NAWS missing: %v", written)
	}
	written = nil
	e.feed([]byte{telnetIAC, telnetDO, 5 /* STATUS */})
	if len(written) == 0 || !bytes.Equal(written[0], []byte{telnetIAC, telnetWONT, 5}) {
		t.Fatalf("WONT STATUS missing: %v", written)
	}
	written = nil
	e.feed([]byte{telnetIAC, telnetWILL, telnetOptECHO})
	if !e.him[telnetOptECHO] {
		t.Fatal("him ECHO should be on")
	}
	if len(written) == 0 || !bytes.Equal(written[0], []byte{telnetIAC, telnetDO, telnetOptECHO}) {
		t.Fatalf("DO ECHO missing: %v", written)
	}
}

func TestTelnetIacEngineNoLoopOnRepeatedDO(t *testing.T) {
	var n int
	e := newTelnetIacEngine(func(b []byte) error {
		n++
		return nil
	}, "xterm-256color")
	e.us[telnetOptTTYPE] = true
	e.feed([]byte{telnetIAC, telnetDO, telnetOptTTYPE})
	if n != 0 {
		t.Fatalf("expected no reply, got %d", n)
	}
}

func TestTelnetIacEngineCRNULNormalized(t *testing.T) {
	e := newTelnetIacEngine(nil, "xterm-256color")
	e.respond = false
	// "A" CR NUL "B"
	out := e.feed([]byte{'A', '\r', 0x00, 'B'})
	if !bytes.Equal(out, []byte{'A', '\r', 'B'}) {
		t.Fatalf("got %v", out)
	}
}

func TestTelnetIacEngineKeepaliveNOP(t *testing.T) {
	var mu sync.Mutex
	var nops int
	e := newTelnetIacEngine(func(b []byte) error {
		if len(b) == 2 && b[0] == telnetIAC && b[1] == telnetNOP {
			mu.Lock()
			nops++
			mu.Unlock()
		}
		return nil
	}, "xterm-256color")
	e.startKeepalive(20 * time.Millisecond)
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := nops
		mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.destroy()
	mu.Lock()
	n := nops
	mu.Unlock()
	if n < 1 {
		t.Fatalf("expected ≥1 NOP, got %d", n)
	}
}

func TestTelnetSendNAWS(t *testing.T) {
	var got []byte
	// fake conn via engine write path is overkill — unit the packet shape via send to buffer conn
	// Use a pipe
	c1, c2 := netPipe(t)
	defer c1.Close()
	defer c2.Close()
	go func() {
		buf := make([]byte, 64)
		n, _ := c2.Read(buf)
		got = append([]byte{}, buf[:n]...)
	}()
	if err := telnetSendNAWS(c1, 120, 40); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	want := []byte{telnetIAC, telnetSB, telnetOptNAWS, 0, 120, 0, 40, telnetIAC, telnetSE}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// netPipe returns a connected pair of net.Conn using TCP localhost.
func netPipe(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	ch := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		ch <- c
	}()
	c1, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c2 := <-ch
	return c1, c2
}
