package rdpgfx

import (
	"encoding/binary"
	"testing"
)

func TestFrameTrackerAcknowledgesStrictlyInStartOrder(t *testing.T) {
	tracker := newFrameTracker()
	for _, id := range []uint32{10, 11} {
		if err := tracker.Start(id); err != nil {
			t.Fatal(err)
		}
		if err := tracker.Seal(id); err != nil {
			t.Fatal(err)
		}
	}
	if err := tracker.Complete(11, 2); err != nil {
		t.Fatal(err)
	}
	if ready := tracker.DrainReady(); len(ready) != 0 {
		t.Fatalf("later frame bypassed earlier: %+v", ready)
	}
	if err := tracker.Complete(10, 3); err != nil {
		t.Fatal(err)
	}
	ready := tracker.DrainReady()
	if len(ready) != 2 || ready[0].id != 10 || ready[1].id != 11 {
		t.Fatalf("unexpected ACK order: %+v", ready)
	}
	if ready[0].depth != 3 || ready[1].depth != 2 {
		t.Fatalf("queue depths lost: %+v", ready)
	}
}

func TestFrameTrackerRejectsInvalidLifecycle(t *testing.T) {
	tracker := newFrameTracker()
	if err := tracker.Seal(1); err == nil {
		t.Fatal("end-before-start accepted")
	}
	if err := tracker.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := tracker.Start(1); err == nil {
		t.Fatal("duplicate start accepted")
	}
	if err := tracker.Complete(1, 0); err == nil {
		t.Fatal("completion-before-end accepted")
	}
	if err := tracker.Seal(1); err != nil {
		t.Fatal(err)
	}
	if err := tracker.Seal(1); err == nil {
		t.Fatal("duplicate end accepted")
	}
	if err := tracker.Complete(1, 0); err != nil {
		t.Fatal(err)
	}
	if err := tracker.Complete(1, 0); err == nil {
		t.Fatal("duplicate completion accepted")
	}
}

func TestFrameTrackerResetClearsBacklog(t *testing.T) {
	tracker := newFrameTracker()
	tracker.Start(5)
	tracker.Reset()
	if tracker.Backlog() != 0 {
		t.Fatal("reset retained backlog")
	}
	if err := tracker.Seal(5); err == nil {
		t.Fatal("reset retained frame")
	}
}

func TestResetGraphicsPreservesTotalFramesDecodedUntilCapsConfirm(t *testing.T) {
	g := &GfxHandler{progressive: newRfxProgressiveDecoder(), frameTracker: newFrameTracker()}
	g.framesDecoded.Store(73)

	reset := make([]byte, 12)
	binary.LittleEndian.PutUint32(reset[0:4], 1920)
	binary.LittleEndian.PutUint32(reset[4:8], 1080)
	g.onResetGraphics(reset)
	if got := g.framesDecoded.Load(); got != 73 {
		t.Fatalf("RESET_GRAPHICS regressed totalFramesDecoded: got %d, want 73", got)
	}

	caps := make([]byte, 12)
	binary.LittleEndian.PutUint32(caps[0:4], 0x000A0701)
	binary.LittleEndian.PutUint32(caps[4:8], 4)
	g.onCapsConfirm(caps)
	if got := g.framesDecoded.Load(); got != 0 {
		t.Fatalf("CAPS_CONFIRM did not start a new decoded-frame sequence: got %d", got)
	}
}

func TestExternalFrameCompletionAppliesQueueDepthHint(t *testing.T) {
	g := &GfxHandler{frameTracker: newFrameTracker()}
	g.SetQueueDepthHint(20)
	if got := g.effectiveQueueDepth(3); got != 20 {
		t.Fatalf("queue depth hint was ignored: got %d, want 20", got)
	}
	if got := g.effectiveQueueDepth(25); got != 25 {
		t.Fatalf("real backlog was reduced by hint: got %d, want 25", got)
	}

	if err := g.frameTracker.Start(42); err != nil {
		t.Fatal(err)
	}
	if err := g.frameTracker.Seal(42); err != nil {
		t.Fatal(err)
	}
	// Inspect the tracker directly here: CompleteFrame also drains the ACK
	// immediately, while this verifies the exact depth stored for that path.
	if err := g.frameTracker.Complete(42, g.effectiveQueueDepth(2)); err != nil {
		t.Fatal(err)
	}
	ready := g.frameTracker.DrainReady()
	if len(ready) != 1 || ready[0].depth != 20 {
		t.Fatalf("external completion lost queue-depth hint: %+v", ready)
	}
}
