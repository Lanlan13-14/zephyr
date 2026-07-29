package agent

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
)

type sequenceEmitter struct{ seqs []int64 }

func (e *sequenceEmitter) Emit(ev event.Event) error {
	e.seqs = append(e.seqs, ev.Seq)
	return nil
}

func TestRunnerResumeContinuesPersistedEventSequence(t *testing.T) {
	store, err := session.Open(filepath.Join(t.TempDir(), "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sess, err := store.CreateSession("u1", "sequence", nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(sess.ID, "u1", "test", "model")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AppendEvent(run.ID, 7, string(event.TypeClientCapture), map[string]any{"ok": true}); err != nil {
		t.Fatal(err)
	}

	emitter := &sequenceEmitter{}
	runner := NewRunner()
	cfg := Config{
		RunID:     run.ID,
		SessionID: sess.ID,
		Store:     store,
		Emitter:   emitter,
		Resume:    &ResumeState{Kind: PausePermission},
		Decision:  &ResumeDecision{Approve: false},
	}
	_, _ = runner.Run(context.Background(), cfg)
	if len(emitter.seqs) == 0 || emitter.seqs[0] != 8 {
		t.Fatalf("resume sequence must continue at 8, got %v", emitter.seqs)
	}
}

func TestRunnerKeepsSequenceIndependentAcrossRuns(t *testing.T) {
	runner := NewRunner()
	if got := runner.nextSeq("run-a"); got != 1 {
		t.Fatalf("run-a first seq=%d", got)
	}
	if got := runner.nextSeq("run-b"); got != 1 {
		t.Fatalf("run-b first seq=%d", got)
	}
	if got := runner.nextSeq("run-a"); got != 2 {
		t.Fatalf("run-a second seq=%d", got)
	}
}
