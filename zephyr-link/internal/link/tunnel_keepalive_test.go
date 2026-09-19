package link

import (
	"bufio"
	"net"
	"testing"
	"time"
)

func TestTunnelIdleTimeoutIsLongEnoughForInteractiveSSH(t *testing.T) {
	if tunnelIdleTimeout < 30*time.Minute {
		t.Fatalf("tunnelIdleTimeout=%s; interactive SSH pauses longer than 5 minutes", tunnelIdleTimeout)
	}
}

func TestTunnelPingIntervalIsBelowCommonNATIdle(t *testing.T) {
	if tunnelPingInterval <= 0 || tunnelPingInterval > 30*time.Second {
		t.Fatalf("tunnelPingInterval=%s; NAT/reverse-proxy idle cuts typically sit at 30-60s", tunnelPingInterval)
	}
}

func TestStreamPingWritesMaskedPingOpcode(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	got := make(chan byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		op, _, err := readFrame(bufio.NewReader(conn))
		if err != nil {
			return
		}
		got <- op
	}()

	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	stream := &tunnelStreamConn{conn: client, br: bufio.NewReader(client)}
	if err := stream.ping(); err != nil {
		t.Fatalf("ping: %v", err)
	}
	select {
	case op := <-got:
		if op != 0x9 {
			t.Fatalf("opcode=%#x, want ping 0x9", op)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for ping frame")
	}
}
