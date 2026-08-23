package link

import (
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

func TestDispatcherRejectsUnregisteredKind(t *testing.T) {
	d := NewDispatcher()
	fr, err := codec.Unpack(mustPack(t, codec.KindSharedNote, map[string]any{"a": 1}, false))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := d.Dispatch(&FrameContext{}, fr); err == nil {
		t.Fatal("unregistered kind dispatched instead of rejected")
	}
}

func TestDispatcherRejectsUnknownKind(t *testing.T) {
	d := NewDispatcher()
	fr, err := codec.Unpack(mustPack(t, 99, map[string]any{"a": 1}, false))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := d.Dispatch(&FrameContext{}, fr); err == nil {
		t.Fatal("unknown kind dispatched instead of rejected")
	}
}

func TestDispatcherRoutesAndValidatesSecret(t *testing.T) {
	d := NewDispatcher()
	var gotChannel codec.Channel
	var gotSecret bool
	d.Register(codec.KindSecret, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		gotChannel = ctx.Channel
		gotSecret = ctx.Secret
		return codec.KindSecret, map[string]any{"ok": true}, true, nil
	})
	// A secret-channel frame packed without the secret flag must be rejected
	// before the handler runs (no compression context sharing).
	bad, err := codec.Unpack(mustPack(t, codec.KindSecret, map[string]any{"x": 1}, false))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := d.Dispatch(&FrameContext{}, bad); err == nil {
		t.Fatal("secret frame without secret flag reached the handler")
	}
	good, err := codec.Unpack(mustPack(t, codec.KindSecret, map[string]any{"x": 1}, true))
	if err != nil {
		t.Fatal(err)
	}
	kind, _, secret, err := d.Dispatch(&FrameContext{SessionID: "s1"}, good)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if kind != codec.KindSecret || !secret {
		t.Fatalf("reply kind=%d secret=%v", kind, secret)
	}
	if gotChannel != codec.ChannelSecret || !gotSecret {
		t.Fatalf("context channel=%v secret=%v", gotChannel, gotSecret)
	}
}

func TestKindChannelMappingCoversRegistry(t *testing.T) {
	cases := map[int]codec.Channel{
		codec.KindControl:        codec.ChannelControl,
		codec.KindSyncOp:         codec.ChannelOwnedSync,
		codec.KindSyncAck:        codec.ChannelOwnedSync,
		codec.KindWake:           codec.ChannelControl,
		codec.KindSecret:         codec.ChannelSecret,
		codec.KindBlobManifest:   codec.ChannelBlob,
		codec.KindBlobChunk:      codec.ChannelBlob,
		codec.KindBlobHave:       codec.ChannelBlob,
		codec.KindFileBridge:     codec.ChannelFileBridge,
		codec.KindRelay:          codec.ChannelSharedTerminal,
		codec.KindSharedTerminal: codec.ChannelSharedTerminal,
		codec.KindSharedRemote:   codec.ChannelSharedRemote,
		codec.KindSharedNote:     codec.ChannelSharedNote,
		codec.KindSharedFile:     codec.ChannelSharedFile,
		codec.KindAI:             codec.ChannelAI,
	}
	for kind, want := range cases {
		if !codec.HasKind(kind) {
			t.Fatalf("kind %d not registered", kind)
		}
		got, ok := codec.ChannelOf(kind)
		if !ok || got != want {
			t.Fatalf("kind %d channel=%v want %v", kind, got, want)
		}
	}
	if codec.HasKind(16) || codec.HasKind(0) {
		t.Fatal("unallocated kind reported as registered")
	}
}

func mustPack(t *testing.T, kind int, body any, secret bool) []byte {
	t.Helper()
	b, err := codec.Pack(kind, body, secret)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
