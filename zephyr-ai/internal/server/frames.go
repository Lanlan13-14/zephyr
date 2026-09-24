package server

import (
	"sync"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/streamnorm"
)

// frameHub fans Contract v2 normalized frames out to live /frames subscribers.
// Same drop policy as the legacy SSE hub: slow subscribers lose frames and
// catch up from the store cursor, so one stuck client cannot stall a run.
type frameHub struct {
	mu   sync.Mutex
	subs map[chan streamnorm.Event]struct{}
	done bool
}

func newFrameHub() *frameHub {
	return &frameHub{subs: make(map[chan streamnorm.Event]struct{})}
}

// Publish stores nothing itself (the Recorder already persisted); it only
// delivers to live subscribers. It matches the NormSink signature so the
// agent loop can call it directly.
func (h *frameHub) Publish(ev streamnorm.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.done {
		return
	}
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
	if ev.Type == "done" || ev.Type == "error" {
		h.done = true
		for ch := range h.subs {
			close(ch)
			delete(h.subs, ch)
		}
	}
}

func (h *frameHub) Subscribe() chan streamnorm.Event {
	ch := make(chan streamnorm.Event, 64)
	h.mu.Lock()
	if h.done {
		close(ch)
		h.mu.Unlock()
		return ch
	}
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *frameHub) Unsubscribe(ch chan streamnorm.Event) {
	h.mu.Lock()
	_, ok := h.subs[ch]
	delete(h.subs, ch)
	h.mu.Unlock()
	if ok {
		close(ch)
	}
}

func (h *frameHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.done = true
	for ch := range h.subs {
		close(ch)
		delete(h.subs, ch)
	}
}
