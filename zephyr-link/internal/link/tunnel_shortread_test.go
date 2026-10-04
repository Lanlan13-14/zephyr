package link

import (
	"bytes"
	"io"
	"net"
	"net/http/httptest"
	"testing"
	"time"
)

// TestAgentTunnelSurvivesShortReads is the regression for uploads above ~128
// KiB hanging at 100% through an Agent bastion. ssh2 reads its socket in 64
// KiB slices while a tunnel frame is 256 KiB, so a Read that returns only
// what was asked for has to keep the rest and hand it out on the next call.
// Dropping that tail on the floor leaves an SSH packet that never finishes,
// and the session waits until it dies.
func TestAgentTunnelSurvivesShortReads(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func(c net.Conn) { defer c.Close(); _, _ = io.Copy(c, c) }(c)
		}
	}()

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	agent := NewNode()
	_, sid, err := agent.Dial(srv.URL, "short-read-agent")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewAgentTunnelHub(agent)
	go func() { _ = hub.Start(srv.URL, sid) }()
	mainHub := NewMainEndTunnelHub(server)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if mainHub.Attach(sid) == nil {
			server.mu.Lock()
			live := server.streamWriters[sid] != nil
			server.mu.Unlock()
			if live {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}

	conn, err := mainHub.DialTunnel(sid, "127.0.0.1", echo.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Big enough to span several frames, read back in the slice size ssh2 uses.
	const size = 2 * 1024 * 1024
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i)
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, 0, size)
	buf := make([]byte, 64*1024)
	for len(got) < size {
		n, err := conn.Read(buf)
		got = append(got, buf[:n]...)
		if err != nil {
			t.Fatalf("short read at %d/%d: %v", len(got), size, err)
		}
	}
	if !bytes.Equal(payload, got) {
		t.Fatal("payload mismatch")
	}
}
