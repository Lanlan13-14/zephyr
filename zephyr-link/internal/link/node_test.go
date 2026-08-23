package link

import (
	"crypto/rand"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/cdc"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// Three nodes over real HTTP: a server peer, a desktop peer and a mobile peer.
// Mobile and desktop each dial the server with a ZSL/2 handshake and exchange
// sealed codec frames, including a blob manifest. This is the runnable proof
// that one Go core serves all three ends of Zephyr Link.
func TestThreeNodesOverHTTP(t *testing.T) {
	server := NewNode()
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	desktop := NewNode()
	mobile := NewNode()

	// Desktop dials the server.
	desktopEp, desktopSession, err := desktop.Dial(srv.URL)
	if err != nil {
		t.Fatalf("desktop dial: %v", err)
	}
	// Mobile dials the server.
	mobileEp, mobileSession, err := mobile.Dial(srv.URL)
	if err != nil {
		t.Fatalf("mobile dial: %v", err)
	}
	if desktopSession == mobileSession {
		t.Fatal("sessions collided")
	}

	// The server node routes business frames through its dispatcher; register the
	// sync and blob lanes the test exercises (a real host wires these to account
	// data). A kind with no handler must be rejected, not echoed.
	server.Dispatcher().Register(codec.KindSyncOp, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		return codec.KindSyncAck, map[string]any{"receivedKind": fr.Kind, "ok": true}, false, nil
	})
	server.Dispatcher().Register(codec.KindBlobManifest, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		return codec.KindSyncAck, map[string]any{"receivedKind": fr.Kind, "ok": true}, false, nil
	})

	// Mobile pushes a sync op; server acks it.
	ackKind, err := mobile.SendFrame(srv.URL, mobileSession, mobileEp, codec.KindSyncOp, map[string]any{
		"op": "upsert", "entity": "note", "id": "n1",
	}, false)
	if err != nil {
		t.Fatalf("mobile send: %v", err)
	}
	if ackKind != codec.KindSyncAck {
		t.Fatalf("ack kind=%d", ackKind)
	}

	// Desktop pushes a blob manifest built with CDC.
	body := make([]byte, 150*1024)
	rand.Read(body)
	accountKey := make([]byte, 32)
	rand.Read(accountKey)
	manifest, err := cdc.BuildManifest(body, accountKey, cdc.Defaults)
	if err != nil {
		t.Fatal(err)
	}
	ackKind, err = desktop.SendFrame(srv.URL, desktopSession, desktopEp, codec.KindBlobManifest, map[string]any{
		"size": manifest.Size, "merkle": manifest.Merkle, "chunks": len(manifest.Chunks),
	}, false)
	if err != nil {
		t.Fatalf("desktop send manifest: %v", err)
	}
	if ackKind != codec.KindSyncAck {
		t.Fatalf("manifest ack kind=%d", ackKind)
	}

	// A frame sealed for the desktop session must not be accepted on mobile's.
	env, err := desktopEp.Send(codec.KindSyncOp, map[string]any{"x": 1}, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mobileEp.Receive(env); err == nil {
		t.Fatal("mobile accepted a frame sealed for the desktop channel")
	}
}
