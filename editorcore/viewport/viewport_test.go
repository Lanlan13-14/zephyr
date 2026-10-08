package viewport

import "testing"

func TestFloorCeilClamp(t *testing.T) {
	r := VisibleRange(10, 25, 40, 20)
	if r.FirstLine != 1 || r.LastLine != 2 || r.FirstY != 20 {
		t.Fatalf("%+v", r)
	}
	empty := VisibleRange(0, 0, 10, 20)
	if empty != (Range{}) {
		t.Fatalf("empty %+v", empty)
	}
	neg := VisibleRange(3, -40, -1, 0)
	if neg.FirstLine != 0 || neg.LastLine != 0 {
		t.Fatalf("non positive height %+v", neg)
	}
}

func TestFrameLineLengths(t *testing.T) {
	f := FrameOf(3, 0, 10, 10, func(i int) int { return (i + 1) * 2 })
	if f.FirstLine != 0 || f.LastLine != 1 || len(f.Lines) != 2 || f.Lines[1].LenChars != 4 {
		t.Fatalf("%+v", f)
	}
}
