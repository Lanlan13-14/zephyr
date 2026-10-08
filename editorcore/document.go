package editorcore

import (
	"time"
	"unicode/utf8"

	"github.com/Lanlan13-14/zephyr-ssh/editorcore/bidi"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/brackets"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/folds"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/guides"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/layout"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/rope"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/selection"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/viewport"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/words"
)

// Direction names match the host JSON. They are not a cache key.
const (
	DirLTR     = "ltr"
	DirRTL     = "rtl"
	DirMixed   = "mixed"
	DirNeutral = "neutral"
)

// Selection is a directed scalar selection. Equal ends are a caret.
type Selection struct {
	Base   int `json:"base"`
	Extent int `json:"extent"`
}

// Document is one text buffer. Text is stored once, as UTF-8 inside the rope.
// Version increments on every mutation and is the only cache identity a caller
// may use; length is deliberately not an identity.
type Document struct {
	id            int64
	text          rope.Rope
	sel           selection.State
	version       uint64
	tabSize       int
	readOnly      bool
	encoding      string
	eol           string
	savedText     string
	savedEncoding string
	savedEOL      string
	baselineSet   bool
	useSpaces     bool
	spacesSet     bool
	undo          []historyEntry
	redo          []historyEntry
	applying      bool
	compound      int
	compoundAt    int
	compoundBase  string
	compoundSel   Selection
	now           time.Time
}

// NewDocument parses UTF-8 into scalars. Invalid bytes become U+FFFD.
func NewDocument(id int64, text string) *Document {
	d := &Document{id: id, text: rope.New(text), tabSize: 2, version: 1, useSpaces: true, spacesSet: true}
	d.ensure()
	return d
}

// ID is the host-assigned document id.
func (d *Document) ID() int64 { return d.id }

// Version changes on every text or selection mutation.
func (d *Document) Version() uint64 { return d.version }

// TabSize is the column width of a tab, used only by indent guides.
func (d *Document) TabSize() int { return d.tabSize }

// SetTabSize records the guide tab width and bumps the version.
func (d *Document) SetTabSize(size int) {
	if size < 0 {
		size = 0
	}
	if d.tabSize == size {
		return
	}
	d.tabSize = size
	d.version++
}

// LenChars is the scalar length.
func (d *Document) LenChars() int { return d.text.LenChars() }

// LenLines matches ropey: a trailing newline adds an empty line.
func (d *Document) LenLines() int { return d.text.LenLines() }

// Text is the only UTF-8 copy of the buffer.
func (d *Document) Text() string { return d.text.String() }

// Selection returns the clamped selection.
func (d *Document) Selection() Selection {
	s := d.sel.Clamp(d.text.LenChars())
	return Selection{Base: s.Base, Extent: s.Extent}
}

// SetSelection clamps both ends and bumps the version when the value changes.
func (d *Document) SetSelection(base, extent int) Selection {
	next := (selection.State{Base: base, Extent: extent}).Clamp(d.text.LenChars())
	if next != d.sel {
		d.sel = next
		d.version++
	}
	return Selection{Base: d.sel.Base, Extent: d.sel.Extent}
}

// Insert inserts UTF-8 at a scalar offset. The caret moves to the end of the
// insertion unless preserve maps the previous selection through it.
func (d *Document) Insert(offset int, text string, preserve bool) Selection {
	if offset < 0 {
		offset = 0
	}
	if offset > d.text.LenChars() {
		offset = d.text.LenChars()
	}
	return d.Replace(offset, offset, text, preserve)
}

// Remove deletes the half-open scalar range.
func (d *Document) Remove(start, end int, preserve bool) Selection {
	return d.Replace(start, end, "", preserve)
}

// Replace applies one edit. preserve maps the pre-edit selection; otherwise
// the caret collapses to the end of the replacement, matching CodeForge.
func (d *Document) Replace(start, end int, text string, preserve bool) Selection {
	if start < 0 {
		start = 0
	}
	if end < start {
		start, end = end, start
	}
	if end > d.text.LenChars() {
		end = d.text.LenChars()
	}
	if !utf8.ValidString(text) {
		text = string([]rune(text))
	}
	if d.readOnly && !d.applying && (start != end || text != "") {
		return d.Selection()
	}
	if !d.applying && (start != end || text != "") {
		deleted := ""
		if end > start {
			deleted = d.Slice(start, end)
		}
		d.record(start, deleted, text, d.compound > 0)
	}
	old := d.sel
	next := d.text.Replace(start, end, text)
	d.text = next
	added := utf8.RuneCountInString(text)
	mapped := selection.Replace(start, end, added, preserve, old, next.LenChars())
	d.sel = mapped
	d.version++
	return Selection{Base: mapped.Base, Extent: mapped.Extent}
}

// Slice returns UTF-8 for a clamped scalar range.
func (d *Document) Slice(start, end int) string { return d.text.Slice(start, end) }

// Char returns the scalar, or -1 past the end.
func (d *Document) Char(offset int) int32 { return d.text.Char(offset) }

// CharToLine and LineToChar are ropey indexes.
func (d *Document) CharToLine(offset int) int { return d.text.CharToLine(offset) }
func (d *Document) LineToChar(line int) int   { return d.text.LineToChar(line) }

// Line returns one line without its break.
func (d *Document) Line(line int) string { return d.text.Line(line) }

// Lines returns [start, end) with breaks stripped.
func (d *Document) Lines(start, end int) []string { return d.text.Lines(start, end) }

// LineStart is the scalar offset of the line containing offset.
func (d *Document) LineStart(offset int) int { return d.text.LineToChar(d.text.CharToLine(offset)) }

// LineEnd is the scalar offset after the line content, before its break.
func (d *Document) LineEnd(offset int) int {
	line := d.text.CharToLine(offset)
	rawStart := d.text.LineToChar(line)
	var rawEnd int
	if line+1 < d.text.LenLines() {
		rawEnd = d.text.LineToChar(line + 1)
	} else {
		rawEnd = d.text.LenChars()
	}
	body := rawEnd - rawStart
	if body >= 2 && d.text.Char(rawEnd-1) == '\n' && d.text.Char(rawEnd-2) == '\r' {
		return rawEnd - 2
	}
	if body >= 1 && d.text.Char(rawEnd-1) == '\n' {
		return rawEnd - 1
	}
	return rawEnd
}

// Snapshot is the UTF-8 text plus the coordinates a host needs to paint one
// edit. It is a view, not a second buffer: Text aliases the rope's bytes only
// for the duration of the call.
type Snapshot struct {
	ID        int64     `json:"id"`
	Version   uint64    `json:"version"`
	Text      string    `json:"text"`
	LenChars  int       `json:"lenChars"`
	LenLines  int       `json:"lenLines"`
	Selection Selection `json:"selection"`
	TabSize   int       `json:"tabSize"`
}

// Snapshot returns the current UTF-8 and selection.
func (d *Document) Snapshot() Snapshot {
	return Snapshot{
		ID: d.id, Version: d.version, Text: d.Text(),
		LenChars: d.LenChars(), LenLines: d.LenLines(),
		Selection: d.Selection(), TabSize: d.tabSize,
	}
}

func (d *Document) runes() []rune { return []rune(d.Text()) }

// Folds are bracket regions that cross at least one line.
func (d *Document) Folds() []folds.Range { return folds.Compute(d.runes()) }

// MatchingBracket returns the partner offset, or -1.
func (d *Document) MatchingBracket(offset int) int { return brackets.Match(d.runes(), offset) }

// Guides recomputes indent guides for the viewport. The result is not cached.
func (d *Document) Guides(firstVisible, lastVisible int) []guides.Block {
	return guides.Compute(d.text, firstVisible, lastVisible, d.tabSize)
}

// Words returns the first-seen completion vocabulary, capped at 5000.
func (d *Document) Words() []string { return words.Extract(d.runes()) }

// BidiSegments classifies every scalar in [start, end). Short runs are not
// treated as LTR.
func (d *Document) BidiSegments(start, end int) []bidi.Segment {
	rs := d.runes()
	if start < 0 {
		start = 0
	}
	if end > len(rs) {
		end = len(rs)
	}
	if start >= end {
		return []bidi.Segment{}
	}
	return bidi.Segments(rs[start:end], start)
}

// BidiSegmentsForLine classifies one logical line, including its break scalars.
func (d *Document) BidiSegmentsForLine(line int) []bidi.Segment {
	if line < 0 {
		line = 0
	}
	if line >= d.LenLines() {
		line = d.LenLines() - 1
	}
	start := d.LineToChar(line)
	end := d.LenChars()
	if line+1 < d.LenLines() {
		end = d.LineToChar(line + 1)
	}
	return d.BidiSegments(start, end)
}

// PrimaryDirection is the majority strong direction. Ties are LTR.
func (d *Document) PrimaryDirection() string {
	return dirName(bidi.PrimaryDirection(d.runes()))
}

// TextDirection is LTR, RTL, or Mixed from the strong scalars present.
func (d *Document) TextDirection() string {
	return dirName(bidi.DocumentDirection(d.runes()))
}

func dirName(d bidi.Direction) string {
	switch d {
	case bidi.RTL:
		return DirRTL
	case bidi.Mixed:
		return DirMixed
	case bidi.Neutral:
		return DirNeutral
	default:
		return DirLTR
	}
}

// LayoutLine is one row fed to a layout map.
type LayoutLine struct {
	LenChars int     `json:"lenChars"`
	Height   float32 `json:"height"`
	Folded   bool    `json:"folded"`
}

// NewLayout builds a layout map from per-line measures.
func NewLayout(lines []LayoutLine) *layout.Map {
	m := layout.New()
	for _, ln := range lines {
		m.PushLine(ln.LenChars, ln.Height, ln.Folded)
	}
	return m
}

// Viewport is the unwrapped window. lineLen may be nil.
func Viewport(totalLines int, viewTop, viewBottom, lineHeight float64, lineLen func(int) int) viewport.Frame {
	return viewport.FrameOf(totalLines, viewTop, viewBottom, lineHeight, lineLen)
}

// UnwrappedFrame sizes each visible line from this document. The length
// includes the line break, matching the Rust viewport frame.
func (d *Document) UnwrappedFrame(viewTop, viewBottom, lineHeight float64) viewport.Frame {
	return viewport.FrameOf(d.LenLines(), viewTop, viewBottom, lineHeight, func(i int) int {
		start := d.LineToChar(i)
		end := d.LenChars()
		if i+1 < d.LenLines() {
			end = d.LineToChar(i + 1)
		}
		return end - start
	})
}
