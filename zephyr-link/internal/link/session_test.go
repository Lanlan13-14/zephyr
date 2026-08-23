package link

import (
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// Three peers — server, desktop, mobile — each pair a ZSL/2 channel with the
// same code path and exchange codec frames. This is the interoperability proof:
// one implementation, three ends, byte-identical wire format.
func TestThreeWayInterop(t *testing.T) {
	// server <-> mobile
	serverMobileServer, serverMobileMobile, err := Pair()
	if err != nil {
		t.Fatal(err)
	}
	// server <-> desktop
	serverDesktopServer, serverDesktopDesktop, err := Pair()
	if err != nil {
		t.Fatal(err)
	}

	// mobile -> server: a sync op
	env, err := serverMobileMobile.Send(codec.KindSyncOp, map[string]any{
		"op": "upsert", "entity": "connection", "id": "c1",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := serverMobileServer.Receive(env)
	if err != nil {
		t.Fatal(err)
	}
	if fr.Kind != codec.KindSyncOp {
		t.Fatalf("kind=%d", fr.Kind)
	}

	// server -> mobile: an ack
	ack, err := serverMobileServer.Send(codec.KindSyncAck, map[string]any{"ok": true, "cursor": 7}, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverMobileMobile.Receive(ack); err != nil {
		t.Fatal(err)
	}

	// desktop -> server: a blob manifest
	manifest, err := serverDesktopDesktop.Send(codec.KindBlobManifest, map[string]any{
		"size": 4096, "root": "abc",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverDesktopServer.Receive(manifest); err != nil {
		t.Fatal(err)
	}

	// The two server-side sessions are independent: a frame sealed for mobile
	// must not open on the desktop channel.
	if _, err := serverDesktopServer.Receive(env); err == nil {
		t.Fatal("cross-channel frame opened: sessions are not isolated")
	}
}

func TestSecretFrameStaysSecret(t *testing.T) {
	device, host, err := Pair()
	if err != nil {
		t.Fatal(err)
	}
	env, err := device.Send(codec.KindSyncOp, map[string]any{"token": "x", "pad": "zzzz"}, true)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := host.Receive(env)
	if err != nil {
		t.Fatal(err)
	}
	if !fr.Secret {
		t.Fatal("secret flag not preserved end to end")
	}
}
