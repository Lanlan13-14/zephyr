package guides

import (
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/editorcore/rope"
)

func TestBracketGuideStopsAtMatch(t *testing.T) {
	doc := rope.New("fn {\n  a\n}\n")
	got := Compute(doc, 0, doc.LenLines()-1, 2)
	if len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	if got[0].StartLine != 0 || got[0].EndLine != 3 || got[0].LeadingSpaces != 0 {
		t.Fatalf("%+v", got[0])
	}
}

func TestColonGuideUsesIndent(t *testing.T) {
	doc := rope.New("a:\n  b\n  c\nd\n")
	got := Compute(doc, 0, 3, 2)
	if len(got) != 1 || got[0].EndLine != 3 || got[0].IndentLevel != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestTabStops(t *testing.T) {
	doc := rope.New("\t{\n\t\tx\n\t}\n")
	got := Compute(doc, 0, 2, 4)
	if len(got) != 1 || got[0].LeadingSpaces != 4 || got[0].IndentLevel != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestOpeningTag(t *testing.T) {
	doc := rope.New("<item>\n  x\n</item>\n")
	got := Compute(doc, 0, 2, 2)
	if len(got) != 1 || got[0].EndLine != 3 {
		t.Fatalf("%+v", got)
	}
}

func TestViewportDoesNotDependOnLength(t *testing.T) {
	// Same length, different structure: a caller must recompute. This package
	// has no cache, so two calls with equal lengths still see the new text.
	a := Compute(rope.New("a:\n  b\n"), 0, 2, 2)
	b := Compute(rope.New("a\n  b\n"), 0, 2, 2)
	if len(a) != 1 || len(b) != 0 {
		t.Fatalf("length-keyed cache would confuse these: %+v %+v", a, b)
	}
}
