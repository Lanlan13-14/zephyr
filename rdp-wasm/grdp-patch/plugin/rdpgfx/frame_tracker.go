package rdpgfx

import (
	"fmt"
	"sync"
)

type trackedFrame struct {
	id       uint32
	sealed   bool
	complete bool
	acked    bool
	depth    uint32
}

type frameTracker struct {
	mu     sync.Mutex
	order  []uint32
	frames map[uint32]*trackedFrame
}

func newFrameTracker() *frameTracker { return &frameTracker{frames: make(map[uint32]*trackedFrame)} }

func (t *frameTracker) Reset() {
	t.mu.Lock()
	t.order = t.order[:0]
	clear(t.frames)
	t.mu.Unlock()
}

func (t *frameTracker) Start(id uint32) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if frame, exists := t.frames[id]; exists && !frame.acked {
		return fmt.Errorf("frame %d already started", id)
	}
	t.frames[id] = &trackedFrame{id: id}
	t.order = append(t.order, id)
	return nil
}

func (t *frameTracker) Seal(id uint32) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	frame := t.frames[id]
	if frame == nil {
		return fmt.Errorf("frame %d ended before start", id)
	}
	if frame.sealed {
		return fmt.Errorf("frame %d ended twice", id)
	}
	frame.sealed = true
	return nil
}

func (t *frameTracker) Complete(id, depth uint32) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	frame := t.frames[id]
	if frame == nil {
		return fmt.Errorf("frame %d completed before start", id)
	}
	if !frame.sealed {
		return fmt.Errorf("frame %d completed before end", id)
	}
	if frame.complete || frame.acked {
		return fmt.Errorf("frame %d completed twice", id)
	}
	frame.complete = true
	frame.depth = depth
	return nil
}

func (t *frameTracker) DrainReady() []trackedFrame {
	t.mu.Lock()
	defer t.mu.Unlock()
	var ready []trackedFrame
	for len(t.order) > 0 {
		id := t.order[0]
		frame := t.frames[id]
		if frame == nil {
			t.order = t.order[1:]
			continue
		}
		if !frame.sealed || !frame.complete {
			break
		}
		frame.acked = true
		ready = append(ready, *frame)
		delete(t.frames, id)
		t.order = t.order[1:]
	}
	return ready
}

func (t *frameTracker) Backlog() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.order)
}
