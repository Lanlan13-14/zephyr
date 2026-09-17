package link

import (
	"net/http/httptest"
	"testing"
	"time"
)

// TestAgentHubRestartsOnNewSession covers the Agent half of the bastion
// reconnect bug. The Agent keeps one tunnel hub for the life of the process
// and calls Start again after it re-dials the Link. The second Start must
// install the new stream, retire the old one, and leave the hub usable.
//
// The dangerous case is ordering: the previous read loop dies *after* the new
// stream is installed. Without the generation stamp its deferred closeAll
// would null out the successor's stream and fire OnLinkLost, leaving the Agent
// with no stream attached while the main end believes the bastion is live.
func TestAgentHubRestartsOnNewSession(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	mainHub := NewMainEndTunnelHub(server)

	agent := NewNode()
	_, session1, err := agent.Dial(srv.URL, "agent-restart-device")
	if err != nil {
		t.Fatalf("dial 1: %v", err)
	}

	lost := make(chan struct{}, 4)
	hub := NewAgentTunnelHub(agent)
	hub.OnLinkLost = func() { lost <- struct{}{} }

	if err := hub.Start(srv.URL, session1); err != nil {
		t.Fatalf("start 1: %v", err)
	}
	if got := hub.SessionID(); got != session1 {
		t.Fatalf("hub session = %q, want %q", got, session1)
	}
	attachWhenLive(t, mainHub, server, session1)

	conn1, err := mainHub.DialTunnel(session1, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial through first stream: %v", err)
	}
	echoThrough(t, conn1, "first-stream")
	conn1.Close()

	// Reconnect: new ZSL/2 session on the same hub object.
	_, session2, err := agent.Dial(srv.URL, "agent-restart-device")
	if err != nil {
		t.Fatalf("dial 2: %v", err)
	}
	if session1 == session2 {
		t.Fatal("expected a fresh session id")
	}
	if err := hub.Start(srv.URL, session2); err != nil {
		t.Fatalf("start 2: %v", err)
	}
	if got := hub.SessionID(); got != session2 {
		t.Fatalf("hub session after restart = %q, want %q", got, session2)
	}

	// Give the retired read loop time to run its deferred teardown. A stale
	// teardown would drop the stream we just installed.
	time.Sleep(200 * time.Millisecond)

	attachWhenLive(t, mainHub, server, session2)
	conn2, err := mainHub.DialTunnel(session2, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial after agent restart: %v", err)
	}
	defer conn2.Close()
	echoThrough(t, conn2, "second-stream")

	// The old stream dying must not be reported as the current link being
	// lost, or the host would re-dial a perfectly healthy stream.
	select {
	case <-lost:
		t.Fatal("OnLinkLost fired for the retired stream")
	default:
	}
}

// TestAgentHubStaleCloseDoesNotKillSuccessor is the narrow unit check for the
// generation guard: a teardown stamped with an old generation must be refused.
func TestAgentHubStaleCloseDoesNotKillSuccessor(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, session1, err := agent.Dial(srv.URL, "agent-generation-device")
	if err != nil {
		t.Fatalf("dial 1: %v", err)
	}
	hub := NewAgentTunnelHub(agent)
	if err := hub.Start(srv.URL, session1); err != nil {
		t.Fatalf("start 1: %v", err)
	}
	hub.mu.Lock()
	staleGeneration := hub.generation
	hub.mu.Unlock()

	_, session2, err := agent.Dial(srv.URL, "agent-generation-device")
	if err != nil {
		t.Fatalf("dial 2: %v", err)
	}
	if err := hub.Start(srv.URL, session2); err != nil {
		t.Fatalf("start 2: %v", err)
	}

	if hub.closeAll(staleGeneration, "stale") {
		t.Fatal("a stale generation was allowed to tear down the live run")
	}
	hub.mu.Lock()
	stream := hub.stream
	hub.mu.Unlock()
	if stream == nil {
		t.Fatal("stale teardown destroyed the live stream")
	}

	hub.mu.Lock()
	liveGeneration := hub.generation
	hub.mu.Unlock()
	if !hub.closeAll(liveGeneration, "real") {
		t.Fatal("the live generation must be able to tear itself down")
	}
}
