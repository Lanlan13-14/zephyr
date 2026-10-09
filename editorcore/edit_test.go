package editorcore

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func openText(t *testing.T, text string) (*Session, int64) {
	t.Helper()
	s := NewSession()
	opened := s.Call(Request{Op: "open", Text: text})
	if !opened.OK {
		t.Fatal(opened.Error)
	}
	return s, opened.Snapshot.ID
}

func TestFindKeepsSpacesCaseRegexAndCycles(t *testing.T) {
	s, id := openText(t, "a a \nA\naa")
	spaced := s.Call(Request{Op: "find", ID: id, Query: "a "})
	plain := s.Call(Request{Op: "find", ID: id, Query: "a"})
	if !spaced.OK || !plain.OK {
		t.Fatal(spaced.Error, plain.Error)
	}
	var spacedRes, plainRes FindResult
	must(t, spaced.Payload, &spacedRes)
	must(t, plain.Payload, &plainRes)
	if len(spacedRes.Matches) != 2 || len(plainRes.Matches) != 5 {
		t.Fatalf("trim changed the query: spaced %d plain %d", len(spacedRes.Matches), len(plainRes.Matches))
	}
	sense := s.Call(Request{Op: "find", ID: id, Query: "A", CaseSensitive: true})
	var senseRes FindResult
	must(t, sense.Payload, &senseRes)
	if senseRes.Count != 1 || senseRes.Matches[0].Start != 5 {
		t.Fatalf("case %+v", senseRes)
	}
	re := s.Call(Request{Op: "find", ID: id, Query: "^a", Regex: true})
	var reRes FindResult
	must(t, re.Payload, &reRes)
	if reRes.Count != 3 {
		t.Fatalf("multiline ^ count %d", reRes.Count)
	}
	bad := s.Call(Request{Op: "find", ID: id, Query: "(", Regex: true})
	var badRes FindResult
	must(t, bad.Payload, &badRes)
	if badRes.Error == "" {
		t.Fatal("bad regexp was silent")
	}
	s.Call(Request{Op: "setSelection", ID: id, Base: 0, Extent: 0})
	first := s.Call(Request{Op: "findNext", ID: id, Query: "a"})
	var firstRes FindResult
	must(t, first.Payload, &firstRes)
	second := s.Call(Request{Op: "findNext", ID: id, Query: "a", From: firstRes.Matches[firstRes.Current].End})
	var secondRes FindResult
	must(t, second.Payload, &secondRes)
	if secondRes.Current == firstRes.Current {
		t.Fatal("next did not move")
	}
	back := s.Call(Request{Op: "findPrevious", ID: id, Query: "a", From: 0})
	var backRes FindResult
	must(t, back.Payload, &backRes)
	if !backRes.Wrapped || backRes.Current != len(backRes.Matches)-1 {
		t.Fatalf("wrap previous %+v", backRes)
	}
}

func TestFindCapsTheReportButNotReplaceAll(t *testing.T) {
	s, id := openText(t, strings.Repeat("a", 1005))
	found := s.Call(Request{Op: "find", ID: id, Query: "a"})
	var res FindResult
	must(t, found.Payload, &res)
	if res.Count != FindLimit || !res.Truncated || res.Total != FindLimit {
		t.Fatalf("cap %+v", res)
	}
	replaced := s.Call(Request{Op: "replaceAll", ID: id, Query: "a", Replacement: "b"})
	var rep ReplaceResult
	must(t, replaced.Payload, &rep)
	if rep.Count != 1005 || strings.Count(replaced.Text, "b") != 1005 || strings.Contains(replaced.Text, "a") {
		t.Fatalf("replaceAll stopped at the window: %+v", rep)
	}
}

func TestReplaceIsLiteralAndReplaceOneAdvances(t *testing.T) {
	s, id := openText(t, "cat cat")
	one := s.Call(Request{Op: "replaceOne", ID: id, Query: "cat", Replacement: "$1", From: 0})
	var oneRes ReplaceResult
	must(t, one.Payload, &oneRes)
	if one.Text != "$1 cat" || !oneRes.Replaced || oneRes.Next == nil || oneRes.Next.Start != 3 {
		t.Fatalf("literal one %+v text %q", oneRes, one.Text)
	}
	all := s.Call(Request{Op: "replaceAll", ID: id, Query: "a.", Regex: true, Replacement: "$1"})
	if all.Text != "$1 c$1" {
		t.Fatalf("regexp replacement expanded: %q", all.Text)
	}
	undo := s.Call(Request{Op: "undo", ID: id})
	if undo.Text != "$1 cat" {
		t.Fatalf("replaceAll was not one undo: %q", undo.Text)
	}
}

func TestUndoMergesTypingAndKeepsCompounds(t *testing.T) {
	d := NewDocument(1, "")
	base := time.UnixMilli(1_000)
	d.SetClock(base)
	d.Type(0, "a")
	d.SetClock(base.Add(100 * time.Millisecond))
	d.Type(1, "b")
	d.SetClock(base.Add(200 * time.Millisecond))
	d.Type(2, " ")
	if d.History().Undo != 2 {
		t.Fatalf("space should split the group, stack %d", d.History().Undo)
	}
	d.Undo()
	d.Undo()
	if d.Text() != "" {
		t.Fatalf("undo left %q", d.Text())
	}
	d.Redo()
	if d.Text() != "ab" {
		t.Fatalf("redo %q", d.Text())
	}
	d.SetClock(base.Add(2 * time.Second))
	d.Type(2, "c")
	if d.History().Undo != 2 || d.History().Redo != 0 {
		t.Fatalf("late type history %+v", d.History())
	}
	many := NewDocument(2, "a\nb")
	many.SetSelection(0, 3)
	many.BeginCompound()
	many.ToggleLineComment("yaml")
	many.EndCompound()
	if many.Text() != "# a\n# b" || many.History().Undo != 1 {
		t.Fatalf("compound text %q stack %d", many.Text(), many.History().Undo)
	}
	many.Undo()
	if many.Text() != "a\nb" {
		t.Fatalf("compound undo %q", many.Text())
	}
	many.Redo()
	if many.Text() != "# a\n# b" {
		t.Fatalf("compound redo %q", many.Text())
	}
}

func TestIndentCommentCopyAndReadOnly(t *testing.T) {
	d := NewDocument(1, "ab\ncd")
	d.SetTabSize(2)
	d.SetSelection(0, 5)
	indented := d.Indent()
	if indented.Text != "  ab\n  cd" {
		t.Fatalf("indent %q", indented.Text)
	}
	d.Outdent()
	if d.Text() != "ab\ncd" {
		t.Fatalf("outdent %q", d.Text())
	}
	d.SetSelection(2, 2)
	d.BreakLine()
	if d.Text() != "ab\n\ncd" {
		t.Fatalf("plain break %q", d.Text())
	}
	pair := NewDocument(2, "f()")
	pair.SetTabSize(2)
	pair.SetSelection(2, 2)
	pair.BreakLine()
	if pair.Text() != "f(\n  \n)" {
		t.Fatalf("pair break %q", pair.Text())
	}
	js := NewDocument(3, "  line")
	js.ToggleLineComment("javascript")
	if js.Text() != "  // line" {
		t.Fatalf("js comment %q", js.Text())
	}
	js.ToggleLineComment("javascript")
	if js.Text() != "  line" {
		t.Fatalf("js uncomment %q", js.Text())
	}
	line := NewDocument(4, "one\ntwo")
	copied := line.CopyText()
	if copied.Text != "one\n" {
		t.Fatalf("copy line %q", copied.Text)
	}
	cut := line.CutText()
	if cut.Text != "one\n" || line.Text() != "two" {
		t.Fatalf("cut %q left %q", cut.Text, line.Text())
	}
	line.SetSelection(0, 1)
	selected := line.CopyText()
	if selected.Text != "t" {
		t.Fatalf("selection copy %q", selected.Text)
	}
	locked := NewDocument(5, "keep")
	locked.SetReadOnly(true)
	if !locked.Type(4, "!").ReadOnly || locked.Text() != "keep" {
		t.Fatal("readonly type")
	}
	if locked.Indent().ReadOnly == false || locked.CutText().ReadOnly == false || locked.Text() != "keep" {
		t.Fatal("readonly command wrote")
	}
	if locked.CopyText().Text != "keep" {
		t.Fatal("readonly copy blocked")
	}
}

func TestFormatReindentsAndTrimsAsOneUndo(t *testing.T) {
	s, id := openText(t, "  a  \n{\nb\n}\t")
	s.Call(Request{Op: "setTabSize", ID: id, TabSize: 2})
	formatted := s.Call(Request{Op: "format", ID: id})
	if formatted.Text != "a\n{\n  b\n}" {
		t.Fatalf("format %q", formatted.Text)
	}
	var result EditResult
	must(t, formatted.Payload, &result)
	if !result.Changed {
		t.Fatal("format did not report a change")
	}
	undone := s.Call(Request{Op: "undo", ID: id})
	if undone.Text != "  a  \n{\nb\n}\t" {
		t.Fatalf("format was not one undo: %q", undone.Text)
	}
	tabs, tabID := openText(t, "{\na\n}")
	tabs.Call(Request{Op: "setUseSpaces", ID: tabID, UseSpaces: boolPtr(false)})
	tabbed := tabs.Call(Request{Op: "format", ID: tabID})
	if tabbed.Text != "{\n\ta\n}" {
		t.Fatalf("tab format %q", tabbed.Text)
	}
	locked, lockedID := openText(t, "  a  ")
	locked.Call(Request{Op: "setReadOnly", ID: lockedID, ReadOnly: true})
	rejected := locked.Call(Request{Op: "format", ID: lockedID})
	must(t, rejected.Payload, &result)
	if !result.ReadOnly || rejected.Text != "  a  " {
		t.Fatalf("readonly format wrote %+v %q", result, rejected.Text)
	}
}

func TestTrimTrailingWhitespaceKeepsBreaks(t *testing.T) {
	s, id := openText(t, "a  \nb\t\n  c")
	trimmed := s.Call(Request{Op: "trimTrailingWhitespace", ID: id})
	if trimmed.Text != "a\nb\n  c" {
		t.Fatalf("trim %q", trimmed.Text)
	}
	again := s.Call(Request{Op: "trimTrailingWhitespace", ID: id})
	var result EditResult
	must(t, again.Payload, &result)
	if result.Changed || again.Text != "a\nb\n  c" {
		t.Fatalf("second trim changed %+v %q", result, again.Text)
	}
	if s.Call(Request{Op: "undo", ID: id}).Text != "a  \nb\t\n  c" {
		t.Fatal("trim undo lost the original")
	}
	empty, emptyID := openText(t, "a \n")
	if empty.Call(Request{Op: "trimTrailingWhitespace", ID: emptyID}).Text != "a\n" {
		t.Fatal("trailing empty line was dropped")
	}
}

func boolPtr(v bool) *bool { return &v }

func TestDirtyTracksTextEncodingAndEOL(t *testing.T) {
	s, id := openText(t, "a\nb")
	clean := s.Call(Request{Op: "meta", ID: id})
	var meta Meta
	must(t, clean.Payload, &meta)
	if meta.Dirty {
		t.Fatalf("fresh document dirty %+v", meta)
	}
	s.Call(Request{Op: "setEOL", ID: id, EOL: "crlf"})
	must(t, s.Call(Request{Op: "meta", ID: id}).Payload, &meta)
	if !meta.Dirty || !meta.EOLDirty || meta.TextDirty {
		t.Fatalf("eol dirty %+v", meta)
	}
	s.Call(Request{Op: "setEOL", ID: id, EOL: "lf"})
	must(t, s.Call(Request{Op: "meta", ID: id}).Payload, &meta)
	if meta.Dirty {
		t.Fatal("reverting eol stayed dirty")
	}
	s.Call(Request{Op: "setEncoding", ID: id, Encoding: "latin1"})
	must(t, s.Call(Request{Op: "meta", ID: id}).Payload, &meta)
	if !meta.EncodingDirty {
		t.Fatal("encoding did not dirty")
	}
	s.Call(Request{Op: "type", ID: id, Offset: 0, Text: "x"})
	s.Call(Request{Op: "undo", ID: id})
	s.Call(Request{Op: "setEncoding", ID: id, Encoding: "utf-8"})
	must(t, s.Call(Request{Op: "meta", ID: id}).Payload, &meta)
	if meta.Dirty || s.Call(Request{Op: "text", ID: id}).Text != "a\nb" {
		t.Fatalf("undo did not restore clean %+v", meta)
	}
}

func TestCapabilityThresholdIsLive(t *testing.T) {
	s, id := openText(t, strings.TrimRight(strings.Repeat("x\n", CapabilityThreshold), "\n"))
	var caps Capabilities
	must(t, s.Call(Request{Op: "capabilities", ID: id}).Payload, &caps)
	if caps.Lines != CapabilityThreshold || caps.Degraded || !caps.Syntax || !caps.Wrap {
		t.Fatalf("5800 %+v", caps)
	}
	s.Call(Request{Op: "replace", ID: id, Start: 0, End: 0, Text: "y\n"})
	must(t, s.Call(Request{Op: "capabilities", ID: id}).Payload, &caps)
	if caps.Lines != CapabilityThreshold+1 || !caps.Degraded || caps.Syntax || caps.Folding || caps.Guides || caps.Wrap {
		t.Fatalf("5801 %+v", caps)
	}
	if !utf8.ValidString(s.Call(Request{Op: "text", ID: id}).Text) {
		t.Fatal("degraded text was not utf-8")
	}
}

func must(t *testing.T, raw []byte, dest any) {
	t.Helper()
	if err := json.Unmarshal(raw, dest); err != nil {
		t.Fatalf("payload %s: %v", raw, err)
	}
}
