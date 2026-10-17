package link

import (
	"net"
	"net/http/httptest"
	"testing"
	"time"
)

// TestRewriteBastionDialHost pins the rule the dialer relies on: only an
// address that actually names this Agent's machine collapses to loopback.
// Anything else, including an address that is merely "local-looking", must
// be forwarded unchanged or the bastion silently steals traffic meant for
// another host on the LAN.
func TestRewriteBastionDialHost(t *testing.T) {
	cases := []struct {
		host, self, want string
	}{
		{"192.168.1.20", "192.168.1.20", "127.0.0.1"},
		{"192.168.1.20", "192.168.1.21", "192.168.1.20"},
		{"WIN-BOX", "win-box", "127.0.0.1"},
		{"127.0.0.1", "127.0.0.1", "127.0.0.1"},
		{"localhost", "localhost", "localhost"},
		{"::1", "::1", "::1"},
		{"", "192.168.1.20", ""},
		{"192.168.1.20", "", "192.168.1.20"},
		{"  10.0.0.5  ", "10.0.0.5", "127.0.0.1"},
	}
	for _, tc := range cases {
		if got := rewriteBastionDialHost(tc.host, tc.self); got != tc.want {
			t.Errorf("rewrite(%q, %q) = %q, want %q", tc.host, tc.self, got, tc.want)
		}
	}
}

// TestBastionToAgentOwnAddressUsesLoopback is the failure the user hits:
// the RDP connection's host is the Windows machine the Agent is installed
// on, so the forwarded target names the Agent itself. The dial has to land
// on the loopback listener, not on whatever the LAN address does from inside
// the host (which is frequently nothing, or the tunnel itself).
func TestBastionToAgentOwnAddressUsesLoopback(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	mainHub := NewMainEndTunnelHub(server)

	agent := NewNode()
	_, session, err := agent.Dial(srv.URL, "agent-self-target")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	hub := NewAgentTunnelHub(agent)
	if err := hub.Start(srv.URL, session); err != nil {
		t.Fatalf("start: %v", err)
	}
	// The test server is on loopback, so the stream's local address is not a
	// LAN address. Name one explicitly: this is the address a real dial
	// records from the socket, and the address the user typed for the RDP host.
	const lan = "192.168.50.20"
	hub.mu.Lock()
	hub.noteSelfLocked(lan)
	hub.mu.Unlock()
	attachWhenLive(t, mainHub, server, session)

	conn, err := mainHub.DialTunnel(session, lan, echoAddr.Port)
	if err != nil {
		t.Fatalf("dial through to own address: %v", err)
	}
	defer conn.Close()
	echoThrough(t, conn, "self-target")
}

// TestTunnelDataDoesNotDropTheAgentLink is the other half of the same
// report: once the self-dial succeeds, RDP immediately pushes a large
// unsolicited stream. With nobody consuming it on the far side the outbound
// queue fills. That congestion used to pin the shared link writer, the
// keepalive missed its window, and the Agent showed up as briefly
// disconnected. The link has to stay up; only the congested tunnel closes.
func TestTunnelDataDoesNotDropTheAgentLink(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		accepted <- c
		// Stand in for RDP's server-first flood: write until the peer stops
		// reading. The pump must not let this pin the link.
		buf := make([]byte, 32*1024)
		for i := range buf {
			buf[i] = byte(i)
		}
		for {
			if _, err := c.Write(buf); err != nil {
				return
			}
		}
	}()

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	mainHub := NewMainEndTunnelHub(server)

	agent := NewNode()
	_, session, err := agent.Dial(srv.URL, "agent-congestion")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	lost := make(chan struct{}, 2)
	hub := NewAgentTunnelHub(agent)
	hub.OnLinkLost = func() { lost <- struct{}{} }
	if err := hub.Start(srv.URL, session); err != nil {
		t.Fatalf("start: %v", err)
	}
	attachWhenLive(t, mainHub, server, session)

	conn, err := mainHub.DialTunnel(session, "127.0.0.1", ln.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer conn.Close()

	// Deliberately never read. Drain just enough to know the flood started,
	// then leave the rest queued so the Agent-side pump hits a full buffer.
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	probe := make([]byte, 1)
	if _, err := conn.Read(probe); err != nil {
		t.Fatalf("flood never reached the main end: %v", err)
	}
	_ = conn.SetReadDeadline(time.Time{})

	var flood net.Conn
	select {
	case flood = <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("flood target never accepted")
	}
	defer flood.Close()

	// Longer than the old failure mode (keepalive written behind a multi-frame
	// seal, then the far side's 3-ping read deadline) and far longer than one
	// write-timeout, so a link that was going to die has died by now.
	time.Sleep(2 * tunnelWriteTimeout)

	select {
	case <-lost:
		t.Fatal("OnLinkLost fired while only a tunnel was congested")
	default:
	}
	hub.mu.Lock()
	stream := hub.stream
	hub.mu.Unlock()
	if stream == nil {
		t.Fatal("congested tunnel tore down the link stream")
	}

	// And the link still carries traffic: a fresh tunnel to an echo server
	// completes while the flooded one is still misbehaving.
	echoAddr := startEcho(t)
	other, err := mainHub.DialTunnel(session, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("second dial after congestion: %v", err)
	}
	defer other.Close()
	echoThrough(t, other, "still-alive")

	// The flooded tunnel must be reclaimable. Closing it from this side has
	// to reach the Agent and drop the local TCP socket; previously the close
	// frame sat behind the payload queue and the socket stayed pinned, which
	// is what eventually exhausted the Agent and bounced its link.
	conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		hub.mu.Lock()
		_, live := hub.tunnels[1]
		hub.mu.Unlock()
		if !live {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closing the congested tunnel did not release it on the Agent")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// And the link is still the same one: releasing the tunnel did not look
	// like a disconnect.
	select {
	case <-lost:
		t.Fatal("releasing the congested tunnel reported the link as lost")
	default:
	}
}
