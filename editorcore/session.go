package editorcore

import "sync"

// Session is the one store of open documents. Hosts address a document by id
// and read its UTF-8 back; they do not keep a parallel text buffer.
type Session struct {
	mu     sync.Mutex
	docs   map[int64]*Document
	next   int64
	layout *layoutStore
}

// NewSession returns an empty session.
func NewSession() *Session {
	return &Session{docs: map[int64]*Document{}}
}

// Open parses text into a new document and returns its snapshot.
func (s *Session) Open(text string) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	d := NewDocument(s.next, text)
	s.docs[d.ID()] = d
	return d.Snapshot()
}

// Close drops a document. Unknown ids are ignored.
func (s *Session) Close(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.docs, id)
}

// Get returns the document, or nil when it is not open.
func (s *Session) Get(id int64) *Document {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.docs[id]
}

func (s *Session) with(id int64, fn func(*Document) (Snapshot, error)) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[id]
	if d == nil {
		return Snapshot{}, errNotOpen
	}
	return fn(d)
}

// Snapshot reads the current UTF-8.
func (s *Session) Snapshot(id int64) (Snapshot, error) {
	return s.with(id, func(d *Document) (Snapshot, error) { return d.Snapshot(), nil })
}
