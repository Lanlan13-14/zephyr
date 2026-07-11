package rdpgfx

import "testing"

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
