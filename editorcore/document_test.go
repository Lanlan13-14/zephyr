package editorcore

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestOpenEditSaveUTF8(t *testing.T) {
	s := NewSession()
	opened := s.Call(Request{Op: "open", Text: "a😀\r\nb"})
	if !opened.OK || opened.Snapshot.LenChars != 5 || opened.Snapshot.LenLines != 2 {
		t.Fatalf("open %+v", opened)
	}
	id := opened.Snapshot.ID
	edited := s.Call(Request{Op: "replace", ID: id, Start: 1, End: 2, Text: "中"})
	if !edited.OK || edited.Text != "a中\r\nb" || edited.Snapshot.Selection.Base != 2 {
		t.Fatalf("edit %+v", edited)
	}
	if edited.Snapshot.Version == opened.Snapshot.Version {
		t.Fatal("version did not move")
	}
	// Same length, different scalars: a length cache would still say LTR-only.
	dir := s.Call(Request{Op: "textDirection", ID: id})
	if dir.Direction != DirLTR {
		t.Fatalf("direction %s", dir.Direction)
	}
	again := s.Call(Request{Op: "text", ID: id})
	if again.Text != edited.Text {
		t.Fatal("snapshot drifted from the edit result")
	}
	saved := []byte(again.Text)
	if !utf8.Valid(saved) || string(saved) != "a中\r\nb" {
		t.Fatalf("save bytes %q", saved)
	}
}

func TestSelectionPreservedAcrossEdit(t *testing.T) {
	d := NewDocument(1, "abcdef")
	d.SetSelection(4, 6)
	got := d.Replace(1, 3, "Z", true)
	// "aZdef": old base 4 was past the edit, delta=-1 -> 3; extent 6 -> 5.
	if got.Base != 3 || got.Extent != 5 || d.Text() != "aZdef" {
		t.Fatalf("sel %+v text %q", got, d.Text())
	}
}

func TestLineEndStopsBeforeCRLF(t *testing.T) {
	d := NewDocument(1, "a\r\nb")
	if d.LineEnd(0) != 1 || d.LineStart(3) != 3 || d.Line(0) != "a" {
		t.Fatalf("start/end %d %d line %q", d.LineEnd(0), d.LineStart(3), d.Line(0))
	}
}

func TestShortHebrewIsNotLTR(t *testing.T) {
	d := NewDocument(1, "שלום")
	if d.TextDirection() != DirRTL || d.PrimaryDirection() != DirRTL {
		t.Fatalf("dir %s primary %s", d.TextDirection(), d.PrimaryDirection())
	}
	segs := d.BidiSegments(0, d.LenChars())
	if len(segs) != 1 || segs[0].End-segs[0].Start != 4 {
		t.Fatalf("short rtl was collapsed: %+v", segs)
	}
	mixed := NewDocument(2, "aא")
	if mixed.TextDirection() != DirMixed {
		t.Fatal("expected mixed")
	}
	// Equal strong counts are LTR, and the version — not the length — changes
	// when the text changes to the same length.
	before := mixed.Version()
	mixed.Replace(0, 1, "b", false)
	if mixed.Text() != "bא" || mixed.Version() == before || mixed.LenChars() != 2 {
		t.Fatalf("same-length edit text=%q ver %d->%d", mixed.Text(), before, mixed.Version())
	}
}

func TestFoldsBracketsGuidesWords(t *testing.T) {
	d := NewDocument(1, "fn {\n  a\n  b\n}\n")
	fs := d.Folds()
	if len(fs) != 1 || fs[0].StartLine != 0 || fs[0].EndLine != 3 {
		t.Fatalf("folds %+v", fs)
	}
	openAt := d.LineEnd(0) - 1
	if got := d.MatchingBracket(openAt); d.CharToLine(got) != 3 {
		t.Fatalf("bracket %d on line %d", got, d.CharToLine(got))
	}
	gs := d.Guides(0, d.LenLines()-1)
	if len(gs) != 1 || gs[0].EndLine != 4 {
		t.Fatalf("guides %+v", gs)
	}
	ws := d.Words()
	if strings.Join(ws, ",") != "fn,a,b" {
		t.Fatalf("words %#v", ws)
	}
}

func TestUnknownDocument(t *testing.T) {
	resp := NewSession().Call(Request{Op: "text", ID: 4})
	if resp.OK || resp.Error == "" {
		t.Fatalf("%+v", resp)
	}
}

func TestViewportAndLayoutRoundTrip(t *testing.T) {
	s := NewSession()
	opened := s.Call(Request{Op: "open", Text: "one\ntwo\nthree\n"})
	frame := s.Call(Request{Op: "viewport", ID: opened.Snapshot.ID, ViewTop: 10, ViewBottom: 25, LineHeight: 10})
	if !frame.OK || !strings.Contains(string(frame.Payload), `"firstLine":1`) {
		t.Fatalf("viewport %s", frame.Payload)
	}
	layoutResp := s.Call(Request{Op: "layoutOpen", Lines: []LayoutLine{
		{LenChars: 4, Height: 10},
		{LenChars: 4, Height: 10, Folded: true},
		{LenChars: 6, Height: 10},
	}})
	if !layoutResp.OK {
		t.Fatalf("layout %s", layoutResp.Error)
	}
}
