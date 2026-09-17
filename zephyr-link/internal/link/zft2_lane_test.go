package link

import (
	"bytes"
	"io"
	"net/http/httptest"
	"testing"
	"time"
)

// The zft2 lane must carry the file protocol's bytes end-to-end over the
// sealed stream: main-end dial, Agent-side Zft2Lane, echo bytes both ways.
func TestZft2LaneEndToEnd(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-zft2-1")
	if err != nil {
		t.Fatal(err)
	}
	agentHub := NewAgentTunnelHub(agent)
	gotLane := make(chan *Zft2Lane, 1)
	agentHub.OnZft2Open = func(l *Zft2Lane) { gotLane <- l }
	go func() { _ = agentHub.Start(srv.URL, sessionID) }()
	select {
	case <-agentHub.Ready():
	case <-time.After(tunnelDialTimeout):
		t.Fatal("agent stream never became ready")
	}
	// Give the server's stream handler a beat to register its writer.
	deadline := time.Now().Add(2 * time.Second)
	for {
		server.mu.Lock()
		_, hasWriter := server.streamWriters[sessionID]
		server.mu.Unlock()
		if hasWriter {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server stream writer never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}

	mainHub := NewMainEndTunnelHub(server)
	if err := mainHub.Attach(sessionID); err != nil {
		t.Fatal(err)
	}

	conn, err := mainHub.DialZft2Lane(sessionID)
	if err != nil {
		t.Fatal("dial zft2 lane:", err)
	}
	defer conn.Close()

	var lane *Zft2Lane
	select {
	case lane = <-gotLane:
	case <-time.After(tunnelDialTimeout):
		t.Fatal("agent never saw the zft2 lane open")
	}

	// Echo server on the Agent side: flip bytes back to the main end.
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := lane.Read(buf)
			if err != nil {
				return
			}
			if _, err := lane.Write(buf[:n]); err != nil {
				return
			}
		}
	}()

	probe := []byte("zft2-lane-probe")
	if _, err := conn.Write(probe); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(tunnelDialTimeout))
	echo := make([]byte, len(probe))
	if _, err := io.ReadFull(conn, echo); err != nil {
		t.Fatal("echo read:", err)
	}
	if !bytes.Equal(probe, echo) {
		t.Fatalf("echo mismatch: %q vs %q", probe, echo)
	}
}

// A zft2 open must be refused — not silently dropped — when the host never
// installed an OnZft2Open dispatcher.
func TestZft2LaneRefusedWithoutDispatcher(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-zft2-2")
	if err != nil {
		t.Fatal(err)
	}
	agentHub := NewAgentTunnelHub(agent) // no OnZft2Open
	go func() { _ = agentHub.Start(srv.URL, sessionID) }()
	select {
	case <-agentHub.Ready():
	case <-time.After(tunnelDialTimeout):
		t.Fatal("agent stream never became ready")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		server.mu.Lock()
		_, hasWriter := server.streamWriters[sessionID]
		server.mu.Unlock()
		if hasWriter {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server stream writer never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}

	mainHub := NewMainEndTunnelHub(server)
	if err := mainHub.Attach(sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := mainHub.DialZft2Lane(sessionID); err == nil {
		t.Fatal("expected refusal without a dispatcher")
	}
}
