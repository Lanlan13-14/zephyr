package streamnorm

import (
	"encoding/json"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

// FrameStore is the persistence seam for normalized frames. The session store
// implements it; tests use a memory fake. Frames persist under the same run
// id as legacy events so replay can serve either stream from one cursor.
type FrameStore interface {
	AppendFrame(runID string, seq int, frame Event) error
	ListFrames(runID string, afterSeq int) ([]StoredFrame, error)
}

// StoredFrame is one persisted frame.
type StoredFrame struct {
	Seq   int             `json:"seq"`
	Type  string          `json:"type"`
	Frame json.RawMessage `json:"frame"`
}

// Recorder wraps a Normalizer with persistence: every emitted frame is stored
// before delivery so a crash between emit and store cannot create a gap the
// replay cursor would skip. Store errors fail the run loudly: a silent gap is
// worse than a failed run because the client would render a partial tool call
// as complete.
type Recorder struct {
	n     *Normalizer
	store FrameStore
	sink  func(Event)
}

// NewRecorder starts a recorder for one run. A nil store disables persistence
// (memory-only unit use); a nil sink disables delivery.
func NewRecorder(runID, modelID, providerAccountID string, store FrameStore, sink func(Event)) *Recorder {
	return &Recorder{n: New(runID, modelID, providerAccountID), store: store, sink: sink}
}

// RunID reports the owning run.
func (r *Recorder) RunID() string { return r.n.RunID }

// Start emits the mandatory opening frame.
func (r *Recorder) Start() error { return r.emit(r.n.Start()) }

// Push converts one provider chunk into stored frames.
func (r *Recorder) Push(c provider.Chunk) error { return r.emit(r.n.Push(c)...) }

// Emit stores then delivers already-built frames.
func (r *Recorder) Emit(events ...Event) error { return r.emit(events...) }

// CloseTool finalizes one tool span.
func (r *Recorder) CloseTool(toolCallID string) error { return r.emit(r.n.CloseTool(toolCallID)) }

// Finish closes spans and emits done.
func (r *Recorder) Finish(stopReason string) error { return r.emit(r.n.Finish(stopReason)...) }

// Fail closes spans and emits a classified error.
func (r *Recorder) Fail(code string) error { return r.emit(r.n.Fail(code)...) }

func (r *Recorder) emit(events ...Event) error {
	for _, e := range events {
		if r.store != nil {
			if err := r.store.AppendFrame(r.n.RunID, e.Sequence, e); err != nil {
				return err
			}
		}
		if r.sink != nil {
			r.sink(e)
		}
	}
	return nil
}
