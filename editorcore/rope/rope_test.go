package rope

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEmptyRopeMatchesRopey(t *testing.T) {
	r := New("")
	if r.LenChars() != 0 || r.LenLines() != 1 {
		t.Fatalf("empty rope chars=%d lines=%d", r.LenChars(), r.LenLines())
	}
	if r.Line(0) != "" || r.CharToLine(0) != 0 || r.LineToChar(0) != 0 || r.Char(0) != -1 {
		t.Fatalf("empty indexing failed: line=%q lineOf0=%d char0=%d", r.Line(0), r.CharToLine(0), r.Char(0))
	}
}

func TestLineBreaksCRLFAndFinalNewline(t *testing.T) {
	r := New("a\r\nb\n")
	if r.LenChars() != 5 || r.LenLines() != 3 {
		t.Fatalf("chars=%d lines=%d", r.LenChars(), r.LenLines())
	}
	lines := r.Lines(0, r.LenLines())
	if strings.Join(lines, "|") != "a|b|" {
		t.Fatalf("lines = %#v", lines)
	}
	// "a \r \n b \n" scalars: 0:a 1:\r 2:\n 3:b 4:\n
	wantLine := []int{0, 0, 0, 1, 1, 2}
	for off, line := range wantLine {
		if got := r.CharToLine(off); got != line {
			t.Fatalf("char %d line %d, want %d", off, got, line)
		}
	}
	if r.LineToChar(0) != 0 || r.LineToChar(1) != 3 || r.LineToChar(2) != 5 {
		t.Fatalf("line starts %d %d %d", r.LineToChar(0), r.LineToChar(1), r.LineToChar(2))
	}
	if r.Char(1) != '\r' || r.Char(2) != '\n' {
		t.Fatalf("crlf chars %q %q", r.Char(1), r.Char(2))
	}
}

func TestScalarOffsetsNotUTF16(t *testing.T) {
	// U+1F600 is one scalar and two UTF-16 code units.
	text := "a😀b"
	r := New(text)
	if r.LenChars() != 3 {
		t.Fatalf("scalars=%d utf16units=%d", r.LenChars(), len([]rune(text)))
	}
	if r.Char(1) != '😀' || r.Slice(1, 2) != "😀" {
		t.Fatalf("emoji char=%q slice=%q", r.Char(1), r.Slice(1, 2))
	}
	if r.Slice(0, 3) != text || r.String() != text {
		t.Fatalf("round trip %q", r.String())
	}
}

func TestLargeRopeLineIndex(t *testing.T) {
	var b strings.Builder
	const lines = 1200
	for i := 0; i < lines; i++ {
		b.WriteString("line-")
		b.WriteString(strings.Repeat("x", i%40))
		if i%17 == 0 {
			b.WriteString(" 中")
		}
		b.WriteByte('\n')
	}
	text := b.String()
	r := New(text)
	if r.LeafCount() < 2 {
		t.Fatalf("expected a chunked rope, leaves=%d scalars=%d", r.LeafCount(), r.LenChars())
	}
	if r.LenLines() != lines+1 || r.LenChars() != utf8.RuneCountInString(text) {
		t.Fatalf("lines=%d chars=%d", r.LenLines(), r.LenChars())
	}
	naive := strings.Split(text, "\n")
	for i, want := range naive {
		if got := r.Line(i); got != want {
			t.Fatalf("line %d got %q want %q", i, got, want)
		}
		if r.CharToLine(r.LineToChar(i)) != i {
			t.Fatalf("round trip line %d", i)
		}
	}
	// A newline itself belongs to the line it terminates.
	off := 0
	for i, line := range naive[:len(naive)-1] {
		off += utf8.RuneCountInString(line)
		if r.CharToLine(off) != i {
			t.Fatalf("newline %d classified as line %d", i, r.CharToLine(off))
		}
		off++ // the '\n'
	}
}

func TestInsertRemoveReplaceClamp(t *testing.T) {
	r := New("abcdef")
	r = r.Insert(3, "XY")
	if r.String() != "abcXYdef" {
		t.Fatalf("insert %q", r.String())
	}
	r = r.Remove(3, 5)
	if r.String() != "abcdef" {
		t.Fatalf("remove %q", r.String())
	}
	r = r.Replace(2, 4, "中")
	if r.String() != "ab中ef" || r.LenChars() != 5 {
		t.Fatalf("replace %q chars=%d", r.String(), r.LenChars())
	}
	r = r.Insert(-4, "[")
	r = r.Insert(99, "]")
	if r.String() != "[ab中ef]" {
		t.Fatalf("clamped insert %q", r.String())
	}
	if New("abc").Remove(5, 1).String() != "a" {
		t.Fatal("swapped range not clamped")
	}
}

func TestCROnlyIsNotABreak(t *testing.T) {
	r := New("a\rb")
	if r.LenLines() != 1 || r.Line(0) != "a\rb" {
		t.Fatalf("CR-only split: lines=%d line=%q", r.LenLines(), r.Line(0))
	}
}
