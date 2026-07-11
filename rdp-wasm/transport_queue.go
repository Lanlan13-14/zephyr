package main

import "sync"

type byteQueue struct {
	mu          sync.Mutex
	chunks      [][]byte
	headOffset  int
	queuedBytes int
	hardLimit   int
	closed      bool
	notify      chan struct{}
}

type queueState struct {
	QueuedBytes  int
	QueuedChunks int
	Closed       bool
}

func newByteQueue(hardLimit int) *byteQueue {
	if hardLimit <= 0 {
		hardLimit = 32 * 1024 * 1024
	}
	return &byteQueue{hardLimit: hardLimit, notify: make(chan struct{}, 1)}
}

func (q *byteQueue) signal() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

func (q *byteQueue) Push(chunk []byte) (queueState, bool) {
	if len(chunk) == 0 {
		return q.State(), true
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || len(chunk) > q.hardLimit-q.queuedBytes {
		return queueState{QueuedBytes: q.queuedBytes, QueuedChunks: len(q.chunks), Closed: q.closed}, false
	}
	q.chunks = append(q.chunks, chunk)
	q.queuedBytes += len(chunk)
	state := queueState{QueuedBytes: q.queuedBytes, QueuedChunks: len(q.chunks)}
	q.signal()
	return state, true
}

func (q *byteQueue) Read(dst []byte) (int, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.chunks) == 0 {
		return 0, q.closed
	}
	chunk := q.chunks[0]
	n := copy(dst, chunk[q.headOffset:])
	q.headOffset += n
	q.queuedBytes -= n
	if q.headOffset == len(chunk) {
		q.chunks[0] = nil
		q.chunks = q.chunks[1:]
		q.headOffset = 0
	}
	return n, false
}

func (q *byteQueue) Close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.signal()
}

func (q *byteQueue) State() queueState {
	q.mu.Lock()
	defer q.mu.Unlock()
	return queueState{QueuedBytes: q.queuedBytes, QueuedChunks: len(q.chunks), Closed: q.closed}
}
