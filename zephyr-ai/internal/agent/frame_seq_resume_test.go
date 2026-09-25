package agent

import (
	"fmt"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/streamnorm"
)

func dupErr(runID string, seq int) error {
	return fmt.Errorf(`constraint failed: UNIQUE constraint failed: ai_frames.run_id, ai_frames.seq (%s/%d)`, runID, seq)
}

// Reproduces the ai_frames UNIQUE(run_id, seq) failure: two Recorders for
// the same run, the second one unseeded, must not collide. Before the fix
// the second Recorder restarted at seq 0.
func TestRecorderReseedAcrossSteps(t *testing.T) {
	store := &memFrameStore{}
	runID := "run_seq_repro"
	// Step 1: full recorder lifecycle.
	rec1 := streamnorm.NewRecorder(runID, "m", "p", store, nil)
	if err := rec1.Start(); err != nil {
		t.Fatal(err)
	}
	if err := rec1.Finish("tool_use"); err != nil {
		t.Fatal(err)
	}
	// Step 2: fresh recorder reseeded from the loop's running seq.
	seq := streamnorm.LastFrameSeq(store, runID)
	if seq < 0 {
		t.Fatalf("expected persisted frames, got seq=%d", seq)
	}
	rec2 := streamnorm.NewRecorder(runID, "m", "p", store, nil)
	rec2.Resume(seq)
	if err := rec2.Start(); err != nil {
		t.Fatalf("step-2 recorder collided: %v", err)
	}
	if err := rec2.Finish("stop"); err != nil {
		t.Fatalf("step-2 finish collided: %v", err)
	}
}

type memFrameStore struct {
	seqs map[string][]int
}

func (m *memFrameStore) AppendFrame(runID string, seq int, frame streamnorm.Event) error {
	if m.seqs == nil {
		m.seqs = map[string][]int{}
	}
	for _, s := range m.seqs[runID] {
		if s == seq {
			return dupErr(runID, seq)
		}
	}
	m.seqs[runID] = append(m.seqs[runID], seq)
	return nil
}

func (m *memFrameStore) ListFrames(runID string, afterSeq int) ([]streamnorm.StoredFrame, error) {
	var out []streamnorm.StoredFrame
	for _, s := range m.seqs[runID] {
		if s > afterSeq {
			out = append(out, streamnorm.StoredFrame{Seq: s})
		}
	}
	return out, nil
}
