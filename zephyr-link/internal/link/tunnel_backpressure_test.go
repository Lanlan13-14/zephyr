package link

import (
	"bytes"
	"io"
	"net"
	"net/http/httptest"
	"testing"
	"time"
)

// TestAgentTunnelUploadSurvivesSlowTarget is the regression for a web upload
// through an Agent bastion dying once the progress bar reaches 100%. The
// browser has handed every byte to the server before the SSH target has
// written them, so the tunnel is asked to buffer a burst far larger than its
// queue while the target drains slowly. The tunnel must absorb that by
// stalling the sender, the way a TCP window would, rather than discarding the
// frame and letting the SSH server answer with EOF.
func TestAgentTunnelUploadSurvivesSlowTarget(t *testing.T) {
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
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 32*1024)
				for {
					n, rerr := c.Read(buf)
					if n > 0 {
						time.Sleep(5 * time.Millisecond)
						if _, werr := c.Write(buf[:n]); werr != nil {
							return
						}
					}
					if rerr != nil {
						return
					}
				}
			}(c)
		}
	}()

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	agent := NewNode()
	_, sid, err := agent.Dial(srv.URL, "slow-target-agent")
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

	// More than the per-tunnel queue can hold, so the old code overflows it
	// and drops the tunnel.
	const size = 96 * 1024 * 1024
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i)
	}
	_ = conn.SetDeadline(time.Now().Add(600 * time.Second))
	if n, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %d/%d: %v", n, len(payload), err)
	}
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("echo read: %v", err)
	}
	if !bytes.Equal(payload, got) {
		t.Fatal("payload mismatch")
	}
}
