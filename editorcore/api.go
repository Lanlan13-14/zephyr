package editorcore

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/editorcore/layout"
)

// Request is one host call. Op selects the operation. Document IDs come from
// open. Text fields are UTF-8.
type Request struct {
	Op            string       `json:"op"`
	ID            int64        `json:"id,omitempty"`
	Text          string       `json:"text,omitempty"`
	Start         int          `json:"start,omitempty"`
	End           int          `json:"end,omitempty"`
	Offset        int          `json:"offset,omitempty"`
	Base          int          `json:"base,omitempty"`
	Extent        int          `json:"extent,omitempty"`
	Preserve      bool         `json:"preserve,omitempty"`
	Line          int          `json:"line,omitempty"`
	TabSize       int          `json:"tabSize,omitempty"`
	FirstVisible  int          `json:"firstVisible,omitempty"`
	LastVisible   int          `json:"lastVisible,omitempty"`
	ViewTop       float64      `json:"viewTop,omitempty"`
	ViewBottom    float64      `json:"viewBottom,omitempty"`
	LineHeight    float64      `json:"lineHeight,omitempty"`
	Fallback      float64      `json:"fallback,omitempty"`
	Lines         []LayoutLine `json:"lines,omitempty"`
	Folded        []int        `json:"folded,omitempty"`
	LayoutID      int64        `json:"layoutId,omitempty"`
	Query         string       `json:"query,omitempty"`
	CaseSensitive bool         `json:"caseSensitive,omitempty"`
	Regex         bool         `json:"regex,omitempty"`
	Wrap          bool         `json:"wrap,omitempty"`
	From          int          `json:"from,omitempty"`
	Dir           int          `json:"dir,omitempty"`
	Replacement   string       `json:"replacement,omitempty"`
	Language      string       `json:"language,omitempty"`
	Encoding      string       `json:"encoding,omitempty"`
	EOL           string       `json:"eol,omitempty"`
	ReadOnly      bool         `json:"readOnly,omitempty"`
	UseSpaces     *bool        `json:"useSpaces,omitempty"`
	At            int64        `json:"at,omitempty"`
}

// Response is either a document snapshot plus the op payload, or an error.
// Text, when present, is the document UTF-8, not a copy kept by the host.
type Response struct {
	OK        bool            `json:"ok"`
	Error     string          `json:"error,omitempty"`
	Snapshot  *Snapshot       `json:"snapshot,omitempty"`
	Text      string          `json:"text,omitempty"`
	Number    *int            `json:"number,omitempty"`
	Lines     []string        `json:"lines,omitempty"`
	Direction string          `json:"direction,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type layoutStore struct {
	next int64
	maps map[int64]*layout.Map
}

func (s *Session) layouts() *layoutStore {
	if s.layout == nil {
		s.layout = &layoutStore{maps: map[int64]*layout.Map{}}
	}
	return s.layout
}

// Call executes one request against this session.
func (s *Session) Call(req Request) Response {
	switch req.Op {
	case "open":
		snap := s.Open(req.Text)
		s.mu.Lock()
		if d := s.docs[snap.ID]; d != nil {
			if req.Encoding != "" {
				d.SetEncoding(req.Encoding)
			}
			if req.EOL != "" {
				d.SetEOL(req.EOL)
			}
			if req.ReadOnly {
				d.SetReadOnly(true)
			}
			if req.TabSize > 0 {
				d.SetTabSize(req.TabSize)
			}
			d.MarkSaved()
			snap = d.Snapshot()
		}
		s.mu.Unlock()
		return Response{OK: true, Snapshot: &snap, Text: snap.Text}
	case "close":
		s.mu.Lock()
		delete(s.docs, req.ID)
		if req.LayoutID != 0 && s.layout != nil {
			delete(s.layout.maps, req.LayoutID)
		}
		s.mu.Unlock()
		return Response{OK: true}
	case "snapshot", "text":
		snap, err := s.Snapshot(req.ID)
		if err != nil {
			return fail(err)
		}
		return Response{OK: true, Snapshot: &snap, Text: snap.Text}
	case "replace", "insert", "remove", "setSelection", "setTabSize":
		return s.editAt(req, func(d *Document) any { return s.applyBasic(d, req) })
	case "slice":
		return s.query(req.ID, func(d *Document) Response {
			return Response{OK: true, Text: d.Slice(req.Start, req.End)}
		})
	case "char":
		return s.query(req.ID, func(d *Document) Response {
			n := int(d.Char(req.Offset))
			return Response{OK: true, Number: &n}
		})
	case "charToLine":
		return s.num(req.ID, func(d *Document) int { return d.CharToLine(req.Offset) })
	case "lineToChar":
		return s.num(req.ID, func(d *Document) int { return d.LineToChar(req.Line) })
	case "line":
		return s.query(req.ID, func(d *Document) Response {
			return Response{OK: true, Text: d.Line(req.Line)}
		})
	case "lines":
		return s.query(req.ID, func(d *Document) Response {
			return Response{OK: true, Lines: d.Lines(req.Start, req.End)}
		})
	case "lineStart":
		return s.num(req.ID, func(d *Document) int { return d.LineStart(req.Offset) })
	case "lineEnd":
		return s.num(req.ID, func(d *Document) int { return d.LineEnd(req.Offset) })
	case "folds":
		return s.payload(req.ID, func(d *Document) any { return d.Folds() })
	case "guides":
		return s.payload(req.ID, func(d *Document) any { return d.Guides(req.FirstVisible, req.LastVisible) })
	case "words":
		return s.payload(req.ID, func(d *Document) any { return d.Words() })
	case "bidi":
		return s.payload(req.ID, func(d *Document) any { return d.BidiSegments(req.Start, req.End) })
	case "bidiLine":
		return s.payload(req.ID, func(d *Document) any { return d.BidiSegmentsForLine(req.Line) })
	case "primaryDirection":
		return s.query(req.ID, func(d *Document) Response {
			return Response{OK: true, Direction: d.PrimaryDirection()}
		})
	case "textDirection":
		return s.query(req.ID, func(d *Document) Response {
			return Response{OK: true, Direction: d.TextDirection()}
		})
	case "viewport":
		return s.payload(req.ID, func(d *Document) any {
			return d.UnwrappedFrame(req.ViewTop, req.ViewBottom, req.LineHeight)
		})
	case "layoutOpen":
		return s.openLayout(req)
	case "layoutViewport":
		return s.layoutFrame(req)
	case "layoutLine":
		return s.layoutLine(req)
	case "find":
		return s.payload(req.ID, func(d *Document) any { return d.Find(queryOf(req)) })
	case "findNext", "findPrevious":
		dir := req.Dir
		if req.Op == "findNext" && dir == 0 {
			dir = 1
		}
		if req.Op == "findPrevious" && dir == 0 {
			dir = -1
		}
		return s.editAt(req, func(d *Document) any { return d.FindGo(queryOf(req), dir) })
	case "replaceOne":
		return s.editAt(req, func(d *Document) any { return d.ReplaceOne(queryOf(req), req.Replacement) })
	case "replaceAll":
		return s.editAt(req, func(d *Document) any { return d.ReplaceAll(queryOf(req), req.Replacement) })
	case "undo":
		return s.editAt(req, func(d *Document) any { res, _ := d.Undo(); return res })
	case "redo":
		return s.editAt(req, func(d *Document) any { res, _ := d.Redo(); return res })
	case "history":
		return s.payload(req.ID, func(d *Document) any { return d.History() })
	case "beginCompound":
		return s.editAt(req, func(d *Document) any { d.BeginCompound(); return d.History() })
	case "endCompound":
		return s.editAt(req, func(d *Document) any { d.EndCompound(); return d.History() })
	case "indent":
		return s.editAt(req, func(d *Document) any { return d.Indent() })
	case "outdent":
		return s.editAt(req, func(d *Document) any { return d.Outdent() })
	case "format":
		return s.editAt(req, func(d *Document) any { return d.Format() })
	case "trimTrailingWhitespace":
		return s.editAt(req, func(d *Document) any { return d.TrimTrailingWhitespace() })
	case "breakLine":
		return s.editAt(req, func(d *Document) any { return d.BreakLine() })
	case "toggleLineComment":
		return s.editAt(req, func(d *Document) any { return d.ToggleLineComment(req.Language) })
	case "copy":
		return s.payload(req.ID, func(d *Document) any { return d.CopyText() })
	case "cut":
		return s.editAt(req, func(d *Document) any { return d.CutText() })
	case "paste":
		return s.editAt(req, func(d *Document) any { return d.Paste(req.Text) })
	case "type":
		return s.editAt(req, func(d *Document) any { return d.Type(req.Offset, req.Text) })
	case "bracket":
		if req.Text != "" {
			return s.editAt(req, func(d *Document) any { return d.BracketPair(req.Text) })
		}
		return s.num(req.ID, func(d *Document) int { return d.MatchingBracket(req.Offset) })
	case "setReadOnly":
		return s.editAt(req, func(d *Document) any { d.SetReadOnly(req.ReadOnly); return d.Meta() })
	case "setEncoding":
		return s.editAt(req, func(d *Document) any { return d.SetEncoding(req.Encoding) })
	case "setEOL":
		return s.editAt(req, func(d *Document) any { return d.SetEOL(req.EOL) })
	case "markSaved":
		return s.editAt(req, func(d *Document) any { return d.MarkSaved() })
	case "meta", "dirty":
		return s.payload(req.ID, func(d *Document) any { return d.Meta() })
	case "capabilities":
		return s.payload(req.ID, func(d *Document) any { return d.Capabilities() })
	case "setUseSpaces":
		return s.editPayload(req.ID, func(d *Document) any {
			on := true
			if req.UseSpaces != nil {
				on = *req.UseSpaces
			}
			d.SetUseSpaces(on)
			return d.UseSpaces()
		})
	case "word":
		return s.num(req.ID, func(d *Document) int { return d.WordMove(req.Offset, req.Dir) })
	default:
		return fail(errors.New("unknown op"))
	}
}

func queryOf(req Request) FindQuery {
	from := req.From
	if from == 0 && req.Offset != 0 {
		from = req.Offset
	}
	return FindQuery{Query: req.Query, CaseSensitive: req.CaseSensitive, Regex: req.Regex, Wrap: req.Wrap, From: from}
}

func (s *Session) edit(id int64, fn func(*Document) Selection) Response {
	snap, err := s.with(id, func(d *Document) (Snapshot, error) {
		fn(d)
		return d.Snapshot(), nil
	})
	if err != nil {
		return fail(err)
	}
	return Response{OK: true, Snapshot: &snap, Text: snap.Text}
}

func (s *Session) query(id int64, fn func(*Document) Response) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[id]
	if d == nil {
		return fail(errNotOpen)
	}
	resp := fn(d)
	snap := d.Snapshot()
	resp.Snapshot = &snap
	return resp
}

func (s *Session) num(id int64, fn func(*Document) int) Response {
	return s.query(id, func(d *Document) Response {
		n := fn(d)
		return Response{OK: true, Number: &n}
	})
}

func (s *Session) editAt(req Request, fn func(*Document) any) Response {
	return s.editPayloadAt(req.ID, req.At, req.At != 0, fn)
}

func (s *Session) applyBasic(d *Document, req Request) Selection {
	switch req.Op {
	case "insert":
		return d.Insert(req.Offset, req.Text, req.Preserve)
	case "remove":
		return d.Remove(req.Start, req.End, req.Preserve)
	case "setSelection":
		return d.SetSelection(req.Base, req.Extent)
	case "setTabSize":
		d.SetTabSize(req.TabSize)
		return d.Selection()
	default:
		return d.Replace(req.Start, req.End, req.Text, req.Preserve)
	}
}

func (s *Session) editPayload(id int64, fn func(*Document) any) Response {
	return s.editPayloadAt(id, 0, false, fn)
}

func (s *Session) editPayloadAt(id int64, at int64, hasAt bool, fn func(*Document) any) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[id]
	if d == nil {
		return fail(errNotOpen)
	}
	if hasAt {
		d.SetClock(time.UnixMilli(at))
	}
	raw, err := json.Marshal(fn(d))
	if err != nil {
		return fail(err)
	}
	snap := d.Snapshot()
	return Response{OK: true, Snapshot: &snap, Text: snap.Text, Payload: raw}
}

func (s *Session) payload(id int64, fn func(*Document) any) Response {
	return s.query(id, func(d *Document) Response {
		raw, err := json.Marshal(fn(d))
		if err != nil {
			return fail(err)
		}
		return Response{OK: true, Payload: raw}
	})
}

func (s *Session) openLayout(req Request) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	store := s.layouts()
	store.next++
	id := store.next
	store.maps[id] = NewLayout(req.Lines)
	raw, _ := json.Marshal(struct {
		LayoutID int     `json:"layoutId"`
		Lines    int     `json:"lines"`
		Height   float64 `json:"height"`
	}{int(id), store.maps[id].LenLines(), store.maps[id].TotalHeight()})
	return Response{OK: true, Payload: raw}
}

func (s *Session) layoutFrame(req Request) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.layouts().maps[req.LayoutID]
	if m == nil {
		return fail(errors.New("layout is not open"))
	}
	raw, _ := json.Marshal(m.BuildViewportFrame(req.ViewTop, req.ViewBottom, req.Fallback))
	return Response{OK: true, Payload: raw}
}

func (s *Session) layoutLine(req Request) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.layouts().maps[req.LayoutID]
	if m == nil {
		return fail(errors.New("layout is not open"))
	}
	n := m.VisualLineFromCharOffset(req.Offset)
	return Response{OK: true, Number: &n}
}

func fail(err error) Response { return Response{OK: false, Error: err.Error()} }
