package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWriteTunnelUpgradeIsRFC101(t *testing.T) {
	var raw strings.Builder
	buf := bufio.NewReadWriter(bufio.NewReader(strings.NewReader("")), bufio.NewWriter(&raw))
	if err := writeTunnelUpgrade(buf); err != nil {
		t.Fatal(err)
	}
	got := raw.String()
	if !strings.HasPrefix(got, "HTTP/1.1 101 Switching Protocols\r\n") {
		t.Fatalf("status line = %q", got)
	}
	if !strings.Contains(got, "Connection: Upgrade\r\n") {
		t.Fatalf("missing Connection: %q", got)
	}
	if !strings.Contains(got, "Upgrade: tcp\r\n") {
		t.Fatalf("missing Upgrade: %q", got)
	}
	if !strings.HasSuffix(got, "\r\n\r\n") {
		t.Fatalf("headers not terminated: %q", got)
	}
}

func TestDialHijackWithout101LeavesNoHTTPStatus(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		brw := bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server))
		_, _ = brw.WriteString("HELLO-TUNNEL")
		_ = brw.Flush()
	}()

	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 32)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(string(buf[:n]), "HTTP/") {
		t.Fatal("pre-fix path must not look like HTTP; this is what Node parsed as Expected HTTP/")
	}
}

func TestDialUpgradeCanBeParsedByNetHTTP(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		brw := bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server))
		if err := writeTunnelUpgrade(brw); err != nil {
			return
		}
		_, _ = brw.WriteString("HELLO-TUNNEL")
		_ = brw.Flush()
	}()

	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	br := bufio.NewReader(client)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("Node-equivalent parser rejected the 101: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "tcp") {
		t.Fatalf("Upgrade = %q", resp.Header.Get("Upgrade"))
	}
	rest := make([]byte, 32)
	n, _ := br.Read(rest)
	if !strings.Contains(string(rest[:n]), "HELLO-TUNNEL") {
		t.Fatalf("tunnel bytes missing after 101: %q", rest[:n])
	}
}

func TestHttptestHijackerStillWorksAfterUpgradeWrite(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		conn, buf, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		if err := writeTunnelUpgrade(buf); err != nil {
			return
		}
		_, _ = buf.WriteString("HELLO-TUNNEL")
		_ = buf.Flush()
	}))
	srv.Start()
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(`{}`))
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d body=%s", resp.StatusCode, body)
	}
}
