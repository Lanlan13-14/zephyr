package link

import (
	"net/http/httptest"
	"testing"
	"time"
)

// TestInitiatorPongDoesNotKillStream is the regression for the bastion
// flakiness after keepalive pings shipped: the main end answers every ping
// with a pong (0xA), but readEnvelope treated any non-data frame as a
// protocol error and tore the stream down every 20 seconds. A connection
// attempt that landed in the reconnect window timed out; Zephyr and Zephyr
// One both showed the Agent hop as randomly unreachable.
//
// The real server (serveStream) answers the hub's keepalive pings itself, so
// surviving one ping interval plus margin proves pong consumption works.
// This test fails on the previous code: the stream died on the first pong.
func TestInitiatorPongDoesNotKillStream(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	one := NewNode()
	_, sessionID, err := one.Dial(srv.URL, "one-device-pong")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	hub := NewInitiatorHub(one)
	if err := hub.Start(srv.URL, sessionID); err != nil {
		t.Fatalf("initiator start: %v", err)
	}
	defer hub.Close()

	// The hub must survive several ping/pong round-trips; the old
	// readEnvelope killed it on the first pong.
	time.Sleep(tunnelPingInterval + 2*time.Second)
	hub.mu.Lock()
	dead := hub.stream == nil
	hub.mu.Unlock()
	if dead {
		t.Fatal("initiator stream died from keepalive pong")
	}
}
