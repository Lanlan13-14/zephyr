package link

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// TestAgentTunnelEndToEnd drives the full bastion data plane: an Agent node
// dials a server node, attaches the stream, and the main end opens a tunnel to
// a local TCP echo server through the sealed AGENT_TUNNEL lane. Every tunnel
// byte must cross the wire only as ciphertext inside ZSL/2 envelopes.
func TestAgentTunnelEndToEnd(t *testing.T) {
	// Plain echo target standing in for the SSH endpoint behind the Agent.
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				io.Copy(c, c)
			}(c)
		}
	}()
	echoAddr := echo.Addr().(*net.TCPAddr)

	// Server node: the main end. Mounts the stream lane.
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	serverRoot := srv.URL

	// Agent node: dials out like the embedded Android runtime, then starts its
	// tunnel hub on the established session.
	agent := NewNode()
	ep, sessionID, err := agent.Dial(serverRoot, "agent-device-1")
	if err != nil {
		t.Fatalf("agent dial: %v", err)
	}
	_ = ep

	hub := NewAgentTunnelHub(agent)
	agentStream := make(chan error, 1)
	go func() { agentStream <- hub.Start(serverRoot, sessionID) }()

	// The server notices the stream attach and registers the main-end hub.
	deadline := time.Now().Add(5 * time.Second)
	var mainHub *MainEndTunnelHub
	for time.Now().Before(deadline) {
		mainHub = NewMainEndTunnelHub(server)
		if err := mainHub.Attach(sessionID); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if mainHub == nil || !mainHub.Attached(sessionID) {
		t.Fatal("main-end hub never attached")
	}

	// Wait for the Agent stream to be live server-side before dialing.
	time.Sleep(150 * time.Millisecond)

	conn, err := mainHub.DialTunnel(sessionID, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer conn.Close()

	payload := []byte("zephyr-link-tunnel-probe")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(payload))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != string(payload) {
		t.Fatalf("echo mismatch: got %q", buf)
	}
	_ = conn.SetReadDeadline(time.Time{})

	// A second chunk proves the bidirectional pump keeps running past the
	// first exchange.
	second := []byte("second-chunk")
	if _, err := conn.Write(second); err != nil {
		t.Fatalf("write 2: %v", err)
	}
	buf2 := make([]byte, len(second))
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, buf2); err != nil {
		t.Fatalf("read echo 2: %v", err)
	}
	if string(buf2) != string(second) {
		t.Fatalf("echo 2 mismatch: got %q", buf2)
	}
}

// TestTunnelClosePropagates verifies close frames tear the conn down on both
// ends instead of leaking the TCP dial on the Agent side.
func TestTunnelClosePropagates(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	var accepted sync.Map
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			accepted.Store(c.RemoteAddr().String(), c)
			go func(c net.Conn) {
				defer c.Close()
				io.Copy(io.Discard, c)
			}(c)
		}
	}()
	port := target.Addr().(*net.TCPAddr).Port

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-device-close")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewAgentTunnelHub(agent)
	go hub.Start(srv.URL, sessionID)

	mainHub := NewMainEndTunnelHub(server)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := mainHub.Attach(sessionID); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)

	conn, err := mainHub.DialTunnel(sessionID, "127.0.0.1", port)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	// The Agent side must observe the close and drop its TCP conn; nothing
	// observable remains except the ack path staying quiet.
	time.Sleep(200 * time.Millisecond)
	hub.mu.Lock()
	left := len(hub.tunnels)
	hub.mu.Unlock()
	if left != 0 {
		t.Fatalf("agent leaked %d tunnel(s) after close", left)
	}
}

// TestTunnelRefusesInvalidTarget proves the Agent rejects malformed targets
// with a structured err frame instead of dialing.
func TestTunnelRefusesInvalidTarget(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-device-bad")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewAgentTunnelHub(agent)
	go hub.Start(srv.URL, sessionID)

	mainHub := NewMainEndTunnelHub(server)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := mainHub.Attach(sessionID); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)

	if _, err := mainHub.DialTunnel(sessionID, "", 0); err == nil {
		t.Fatal("expected refusal for empty target")
	}
	if _, err := mainHub.DialTunnel(sessionID, "127.0.0.1", -1); err == nil {
		t.Fatal("expected refusal for negative port")
	}
}

// TestPushStreamFrameRequiresLiveStream pins the security property that a
// session without a stream attachment refuses server-originated frames.
func TestPushStreamFrameRequiresLiveStream(t *testing.T) {
	n := NewNode()
	if err := n.PushStreamFrame("no-such-session", codec.KindAgentTunnel, map[string]any{"op": "open"}, false); err == nil {
		t.Fatal("push on unknown session must fail")
	}
	// Attach a real stream, then confirm the writer registers.
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-device-push")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewAgentTunnelHub(agent)
	go hub.Start(srv.URL, sessionID)
	time.Sleep(200 * time.Millisecond)
	server.mu.Lock()
	w := server.streamWriters[sessionID]
	server.mu.Unlock()
	if w == nil {
		t.Fatal("stream writer never registered server-side")
	}
	_ = bufio.NewReader // keep imports honest if assertions change
	_ = strings.TrimSpace
	_ = json.Marshal
	_ = http.MethodPost
}

func TestStreamPeerIdentityRestoresHostnameForIPLiteral(t *testing.T) {
	parsed, err := url.Parse("https://203.0.113.10:8443/api/link/v2")
	if err != nil {
		t.Fatal(err)
	}
	sni, host := streamPeerIdentity(parsed, "ssh.example.com")
	if sni != "ssh.example.com" {
		t.Fatalf("sni=%q", sni)
	}
	if host != "ssh.example.com:8443" {
		t.Fatalf("host=%q", host)
	}

	parsed443, err := url.Parse("https://203.0.113.10/api/link/v2")
	if err != nil {
		t.Fatal(err)
	}
	sni, host = streamPeerIdentity(parsed443, "ssh.example.com")
	if sni != "ssh.example.com" || host != "ssh.example.com" {
		t.Fatalf("default-port sni=%q host=%q", sni, host)
	}

	named, err := url.Parse("https://ssh.example.com/api/link/v2")
	if err != nil {
		t.Fatal(err)
	}
	sni, host = streamPeerIdentity(named, "")
	if sni != "ssh.example.com" || host != "ssh.example.com" {
		t.Fatalf("named sni=%q host=%q", sni, host)
	}
}
