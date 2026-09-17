package link

import (
	"io"
	"net"
	"net/http/httptest"
	"testing"
	"time"
)

// startEcho spins a loopback TCP echo server standing in for the SSH endpoint
// that lives behind an Agent.
func startEcho(t *testing.T) *net.TCPAddr {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				io.Copy(c, c)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr)
}

// attachWhenLive waits for the Agent's /link/stream to register server-side,
// then attaches the session to the hub.
func attachWhenLive(t *testing.T, hub *MainEndTunnelHub, server *Node, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		server.mu.Lock()
		_, live := server.streamWriters[sessionID]
		server.mu.Unlock()
		if live {
			if err := hub.Attach(sessionID); err != nil {
				t.Fatalf("attach %s: %v", sessionID, err)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("stream for %s never went live", sessionID)
}

func echoThrough(t *testing.T, conn net.Conn, probe string) {
	t.Helper()
	if _, err := conn.Write([]byte(probe)); err != nil {
		t.Fatalf("write %q: %v", probe, err)
	}
	buf := make([]byte, len(probe))
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo of %q: %v", probe, err)
	}
	if string(buf) != probe {
		t.Fatalf("echo mismatch: got %q want %q", buf, probe)
	}
	_ = conn.SetReadDeadline(time.Time{})
}

// TestBastionSurvivesAgentReconnect is the regression for "session has no live
// stream" on an Agent that had already been used as a bastion once.
//
// The Agent reconnects on a brand-new ZSL/2 session id. The hub used to keep
// the first session id for the life of the process and refuse the new one with
// "hub already attached"; the Node front end swallowed that error, dialed
// anyway, and the push landed on the dead session.
func TestBastionSurvivesAgentReconnect(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	hub := NewMainEndTunnelHub(server)

	agent1 := NewNode()
	_, session1, err := agent1.Dial(srv.URL, "agent-device-1")
	if err != nil {
		t.Fatalf("dial 1: %v", err)
	}
	hub1 := NewAgentTunnelHub(agent1)
	if err := hub1.Start(srv.URL, session1); err != nil {
		t.Fatalf("agent tunnel 1: %v", err)
	}
	attachWhenLive(t, hub, server, session1)

	conn1, err := hub.DialTunnel(session1, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial through first session: %v", err)
	}
	echoThrough(t, conn1, "before-reconnect")
	conn1.Close()

	// The Agent drops and comes back: same device, fresh session id.
	agent2 := NewNode()
	_, session2, err := agent2.Dial(srv.URL, "agent-device-1")
	if err != nil {
		t.Fatalf("dial 2: %v", err)
	}
	if session1 == session2 {
		t.Fatal("expected a fresh session id after reconnect")
	}
	hub2 := NewAgentTunnelHub(agent2)
	if err := hub2.Start(srv.URL, session2); err != nil {
		t.Fatalf("agent tunnel 2: %v", err)
	}
	attachWhenLive(t, hub, server, session2)

	conn2, err := hub.DialTunnel(session2, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial after reconnect: %v", err)
	}
	defer conn2.Close()
	echoThrough(t, conn2, "after-reconnect")
}

// TestTwoAgentsBastionConcurrently proves the hub is not a single-Agent
// object: two enrolled Agents must be usable as bastions at the same time,
// each dialing through its own session.
func TestTwoAgentsBastionConcurrently(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	hub := NewMainEndTunnelHub(server)

	agentA := NewNode()
	_, sessionA, err := agentA.Dial(srv.URL, "agent-device-A")
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	hubA := NewAgentTunnelHub(agentA)
	if err := hubA.Start(srv.URL, sessionA); err != nil {
		t.Fatalf("agent tunnel A: %v", err)
	}
	attachWhenLive(t, hub, server, sessionA)

	agentB := NewNode()
	_, sessionB, err := agentB.Dial(srv.URL, "agent-device-B")
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	hubB := NewAgentTunnelHub(agentB)
	if err := hubB.Start(srv.URL, sessionB); err != nil {
		t.Fatalf("agent tunnel B: %v", err)
	}
	attachWhenLive(t, hub, server, sessionB)

	connA, err := hub.DialTunnel(sessionA, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial through A: %v", err)
	}
	defer connA.Close()
	connB, err := hub.DialTunnel(sessionB, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial through B: %v", err)
	}
	defer connB.Close()

	// Interleave so a cross-session mix-up shows up as a wrong echo.
	echoThrough(t, connA, "through-agent-A")
	echoThrough(t, connB, "through-agent-B")
	echoThrough(t, connA, "A-again")
	echoThrough(t, connB, "B-again")

	if got := hub.DeviceID(sessionA); got != "agent-device-A" {
		t.Fatalf("session A device = %q, want agent-device-A", got)
	}
	if got := hub.DeviceID(sessionB); got != "agent-device-B" {
		t.Fatalf("session B device = %q, want agent-device-B", got)
	}
}

// TestDialUnattachedSessionIsRefused keeps the failure honest: dialing a
// session that was never attached must error instead of silently pushing onto
// some other Agent's stream.
func TestDialUnattachedSessionIsRefused(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	hub := NewMainEndTunnelHub(server)

	if _, err := hub.DialTunnel("no-such-session", "127.0.0.1", 22); err == nil {
		t.Fatal("expected a dial on an unattached session to fail")
	}
	if hub.Attached("no-such-session") {
		t.Fatal("unknown session must not report as attached")
	}
	if err := hub.Attach(""); err == nil {
		t.Fatal("expected an empty session id to be refused")
	}
}

// TestDetachIsolatesOneAgent verifies tearing one Agent down leaves the other
// Agent's bastion lane intact.
func TestDetachIsolatesOneAgent(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	hub := NewMainEndTunnelHub(server)

	agentA := NewNode()
	_, sessionA, err := agentA.Dial(srv.URL, "agent-device-A")
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	hubA := NewAgentTunnelHub(agentA)
	if err := hubA.Start(srv.URL, sessionA); err != nil {
		t.Fatalf("agent tunnel A: %v", err)
	}
	attachWhenLive(t, hub, server, sessionA)

	agentB := NewNode()
	_, sessionB, err := agentB.Dial(srv.URL, "agent-device-B")
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	hubB := NewAgentTunnelHub(agentB)
	if err := hubB.Start(srv.URL, sessionB); err != nil {
		t.Fatalf("agent tunnel B: %v", err)
	}
	attachWhenLive(t, hub, server, sessionB)

	hub.Detach(sessionA)
	if hub.Attached(sessionA) {
		t.Fatal("detached session still reports attached")
	}
	if _, err := hub.DialTunnel(sessionA, "127.0.0.1", echoAddr.Port); err == nil {
		t.Fatal("expected dial on the detached session to fail")
	}

	connB, err := hub.DialTunnel(sessionB, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("surviving session must still dial: %v", err)
	}
	defer connB.Close()
	echoThrough(t, connB, "B-survives-A-detach")
}
