package link

import (
	"net/http/httptest"
	"testing"
	"time"
)

// TestOneRelaySpliceRecoversAfterStreamDrop covers the One-side failure mode
// reported as "agent bastion test often times out": when the initiator's
// stream dies mid-flight (pong mishandling, NAT cut, server restart), the
// next DialRelay must transparently re-attach a stream on the same session
// instead of failing until the app restarts.
func TestOneRelaySpliceRecoversAfterStreamDrop(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	mainHub := NewMainEndTunnelHub(server)

	agent := NewNode()
	_, agentSession, err := agent.Dial(srv.URL, "agent-device-recover")
	if err != nil {
		t.Fatalf("agent dial: %v", err)
	}
	mainHub.SetOneRelayAuth(func(oneDeviceID, agentID, host string, port int) (string, error) {
		return agentSession, nil
	})
	agentHub := NewAgentTunnelHub(agent)
	if err := agentHub.Start(srv.URL, agentSession); err != nil {
		t.Fatalf("agent tunnel: %v", err)
	}
	attachWhenLive(t, mainHub, server, agentSession)

	one := NewNode()
	_, oneSession, err := one.Dial(srv.URL, "one-device-recover")
	if err != nil {
		t.Fatalf("one dial: %v", err)
	}
	hub := NewInitiatorHub(one)
	if err := hub.Start(srv.URL, oneSession); err != nil {
		t.Fatalf("initiator start: %v", err)
	}

	conn, err := hub.DialRelay("agent-device-recover", "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("first relay dial: %v", err)
	}
	echoThrough(t, conn, "before-drop")
	conn.Close()

	// Kill the initiator's stream behind the hub's back (network blip).
	hub.mu.Lock()
	stream := hub.stream
	hub.mu.Unlock()
	if stream == nil {
		t.Fatal("no stream to drop")
	}
	stream.Close()
	// Let the read loop observe the death.
	time.Sleep(150 * time.Millisecond)

	// A restart on the same session must make DialRelay work again.
	if err := hub.Start(srv.URL, oneSession); err != nil {
		t.Fatalf("initiator restart: %v", err)
	}
	conn2, err := hub.DialRelay("agent-device-recover", "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("relay dial after drop: %v", err)
	}
	defer conn2.Close()
	echoThrough(t, conn2, "after-drop")
}
