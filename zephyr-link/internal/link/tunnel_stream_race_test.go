package link

import (
	"net"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// TestStreamReattachDoesNotDropSuccessor pins the main-end side of a bastion
// reconnect: serveStream used to delete streamWriters[sessionID]
// unconditionally on exit. When a client re-attaches a fresh stream for the
// same session before the retired reader goroutine finishes, the retiree
// deleted the successor's registration, so an online Agent had no push path
// and every bastion dial timed out until the Agent reconnected again.
func TestStreamReattachDoesNotDropSuccessor(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-device-reattach")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	hub := NewAgentTunnelHub(agent)
	_ = hub
	if err := hub.Start(srv.URL, sessionID); err != nil {
		t.Fatalf("tunnel start: %v", err)
	}
	mainHub := NewMainEndTunnelHub(server)
	attachWhenLive(t, mainHub, server, sessionID)

	// Take the server-side raw connection of the first stream, then force the
	// Agent to re-attach a fresh stream for the same session.
	server.mu.Lock()
	var first net.Conn
	for _, w := range server.streamWriters {
		first = w.conn
	}
	server.mu.Unlock()
	if first == nil {
		t.Fatal("first stream never registered")
	}

	// Simulate the race: retire the first stream while a second attaches.
	// A close of the first TCP conn triggers serveStream's deferred cleanup.
	// A stream may re-attach on the SAME session (the tunnel reconnect path):
	// Start installs a fresh stream for sessionID while the retired reader is
	// still winding down. Reuse the same node's endpoint for the new stream.
	hub.mu.Lock()
	oldStream := hub.stream
	hub.mu.Unlock()
	_ = oldStream
	h2 := NewAgentTunnelHub(agent)
	if err := h2.Start(srv.URL, sessionID); err != nil {
		t.Fatalf("second start: %v", err)
	}
	_ = oldStream

	// Give the second stream a moment to register, then kill the first.
	time.Sleep(50 * time.Millisecond)
	first.Close()

	// The successor must still be registered and usable.
	deadline := time.Now().Add(5 * time.Second)
	for {
		server.mu.Lock()
		_, live := server.streamWriters[sessionID]
		server.mu.Unlock()
		if live {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("retired stream dropped the successor's registration")
		}
		time.Sleep(10 * time.Millisecond)
	}

	conn, err := mainHub.DialTunnel(sessionID, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial after re-attach: %v", err)
	}
	defer conn.Close()
	echoThrough(t, conn, "after-reattach")
}

// TestStreamPongAndPushDoNotInterleave proves the single-writer fix on the
// main end: keepalive pong frames and bastion tunnel data previously used
// independent locks around two-write frames, so concurrent sends could
// interleave header and payload bytes and corrupt the WebSocket stream.
func TestStreamPongAndPushDoNotInterleave(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-device-interleave")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	hub := NewAgentTunnelHub(agent)
	_ = hub
	if err := hub.Start(srv.URL, sessionID); err != nil {
		t.Fatalf("tunnel start: %v", err)
	}
	mainHub := NewMainEndTunnelHub(server)
	attachWhenLive(t, mainHub, server, sessionID)

	// Hammer the two server->client write paths at once: push tunnel frames
	// (streamPushWriter) while the server answers the Agent's keepalive pings
	// (pong via the same writer now). Any interleaving kills the Agent's read
	// loop within seconds; surviving a sustained burst proves serialization.
	done := make(chan struct{})
	var wg sync.WaitGroup
	conn, err := mainHub.DialTunnel(sessionID, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	wg.Add(1)
	go func() {
		defer wg.Done()
		probe := []byte("interleave-probe")
		for i := 0; i < 40; i++ {
			if _, err := conn.Write(probe); err != nil {
				return
			}
			buf := make([]byte, len(probe))
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, err := ioReadFull(conn, buf); err != nil {
				return
			}
			_ = conn.SetReadDeadline(time.Time{})
			time.Sleep(25 * time.Millisecond)
		}
		close(done)
	}()

	// Ping the Agent's stream from the server side throughout, forcing
	// pong writes concurrent with push data. The Agent's readEnvelope
	// answers pings on its write lock; the server writes pong on the same
	// streamPushWriter mutex as tunnel data.
	server.mu.Lock()
	var raw net.Conn
	for _, w := range server.streamWriters {
		raw = w.conn
	}
	server.mu.Unlock()
	pings := time.NewTicker(20 * time.Millisecond)
	defer pings.Stop()
	for {
		select {
		case <-done:
			wg.Wait()
			hub.mu.Lock()
			dead := hub.stream == nil
			hub.mu.Unlock()
			if dead {
				t.Fatal("agent stream died under concurrent pong/push writes")
			}
			return
		case <-pings.C:
			if raw == nil {
				t.Fatal("no stream to ping")
			}
			if err := writeServerFrame(raw, 0x9, nil); err != nil {
				t.Fatal("ping write failed:", err)
			}
		}
	}
}

func ioReadFull(c net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := c.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
