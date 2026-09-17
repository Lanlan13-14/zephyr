package link

import (
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestAgentTunnelThroughNodeWs is the production hop: Agent Go dials Node's
// `ws` library, which reverse-proxies onto Go handleStream. The previous Go
// unit tests never left httptest, so they could not see that Node rejected
// the Agent's handshake (bad Sec-WebSocket-Key) and then its frames (no MASK).
//
// If this test fails, the user-facing symptom is "session has no live stream"
// because the Agent never attached.
func TestAgentTunnelThroughNodeWs(t *testing.T) {
	echoAddr := startEcho(t)

	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	proxyPort := startNodeWsProxy(t, srv.URL)

	agent := NewNode()
	_, sessionID, err := agent.Dial(srv.URL, "agent-device-node-hop")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	hub := NewAgentTunnelHub(agent)
	peer := fmt.Sprintf("http://127.0.0.1:%d/api/link/v2", proxyPort)
	if err := hub.Start(peer, sessionID); err != nil {
		t.Fatalf("agent stream through Node ws: %v", err)
	}

	mainHub := NewMainEndTunnelHub(server)
	attachWhenLive(t, mainHub, server, sessionID)

	conn, err := mainHub.DialTunnel(sessionID, "127.0.0.1", echoAddr.Port)
	if err != nil {
		t.Fatalf("dial tunnel through Node hop: %v", err)
	}
	defer conn.Close()
	echoThrough(t, conn, "through-node-ws")
}

func startNodeWsProxy(t *testing.T, target string) int {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	repo := findRepoRoot(t)
	script := filepath.Join(repo, "tests", "helpers", "ws-stream-proxy.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("missing %s: %v", script, err)
	}
	cmd := exec.Command(node, script, target)
	cmd.Dir = repo
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	buf := make([]byte, 64)
	n, err := stdout.Read(buf)
	if err != nil {
		t.Fatalf("node proxy did not print a port: %v", err)
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(buf[:n])))
	if err != nil {
		t.Fatalf("node proxy port %q: %v", buf[:n], err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if err == nil {
			c.Close()
			return port
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("node proxy never accepted tcp on %d", port)
	return 0
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "zephyr-link")); err == nil {
				return dir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("repo root not found")
		}
		dir = parent
	}
}
