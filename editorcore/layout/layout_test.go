package layout

import "testing"

func buildSample() *Map {
	m := New()
	// 10 lines of 10 chars, height 20, except line 3 folded and line 4 height 40.
	for i := 0; i < 10; i++ {
		h := float32(20)
		folded := false
		if i == 3 {
			folded = true
		}
		if i == 4 {
			h = 40
		}
		m.PushLine(10, h, folded)
	}
	return m
}

func TestPushInsertRemoveTotals(t *testing.T) {
	m := buildSample()
	if m.LenLines() != 10 {
		t.Fatalf("lines %d", m.LenLines())
	}
	// 8*20 + 40, folded line contributes 0.
	if m.TotalHeight() != 200 {
		t.Fatalf("height %v", m.TotalHeight())
	}
	m.InsertLine(0, 3, 10, false)
	if m.LenLines() != 11 || m.VisualLineFromCharOffset(0) != 0 || m.VisualLineFromCharOffset(3) != 1 {
		t.Fatalf("insert failed lines=%d off0=%d off3=%d lines=%v", m.LenLines(), m.VisualLineFromCharOffset(0), m.VisualLineFromCharOffset(3), m.DebugLines())
	}
	m.RemoveLine(0)
	m.UpdateLine(4, 10, 5, true)
	if m.LenLines() != 10 || m.TotalHeight() != 160 {
		t.Fatalf("after update lines=%d height=%v", m.LenLines(), m.TotalHeight())
	}
	m.RemoveLine(100)
	m.UpdateLine(-1, 1, 1, false)
	if m.LenLines() != 10 {
		t.Fatal("out of range mutated the map")
	}
}

func TestCharOffsetBiasLeft(t *testing.T) {
	m := buildSample()
	// Each line owns 10 scalars. Offset 10 is the first scalar of line 1.
	if got := m.VisualLineFromCharOffset(10); got != 1 {
		t.Fatalf("boundary offset -> %d", got)
	}
	if got := m.VisualLineFromCharOffset(9); got != 0 {
		t.Fatalf("last of line 0 -> %d", got)
	}
	if got := m.VisualLineFromCharOffset(100); got != 9 {
		t.Fatalf("end -> %d", got)
	}
	if got := New().VisualLineFromCharOffset(0); got != 0 {
		t.Fatal("empty map")
	}
}

func TestVisibleRangeSkipsFoldedHeight(t *testing.T) {
	m := buildSample()
	// Heights: 20,20,20,0,40,20... y of line 4 is 60.
	r := m.VisibleRangeByHeight(60, 100)
	if r.FirstLine != 4 || r.FirstY != 60 {
		t.Fatalf("start %+v", r)
	}
	frame := m.BuildViewportFrame(0, 59, 20)
	// Lines whose top is <= 59: lines 0,1,2 and the folded line 3 (top 60 is not included).
	if frame.FirstLine != 0 || len(frame.Lines) != 3 {
		t.Fatalf("frame %+v", frame)
	}
	folded := m.BuildViewportFrame(60, 60, 20)
	if len(folded.Lines) != 1 || folded.Lines[0].Height != 40 {
		t.Fatalf("line at boundary %+v", folded)
	}
}

func TestManyLinesRebalance(t *testing.T) {
	m := New()
	for i := 0; i < 200; i++ {
		m.PushLine(i+1, 10, i%17 == 0 && i != 0)
	}
	if m.LenLines() != 200 {
		t.Fatalf("lines %d", m.LenLines())
	}
	wantChars := 0
	for i := 0; i < 200; i++ {
		if got := m.VisualLineFromCharOffset(wantChars); got != i {
			t.Fatalf("offset %d line %d want %d", wantChars, got, i)
		}
		wantChars += i + 1
	}
	frame := m.BuildViewportFrame(100, 250, 10)
	if frame.FirstLine != 10 || frame.Lines[0].LenChars != 11 {
		t.Fatalf("frame start %+v first line %+v", frame.FirstLine, frame.Lines[0])
	}
	// Delete from the middle and check the following line slid into place.
	m.RemoveLine(10)
	if m.LenLines() != 199 || m.VisualLineFromCharOffset(55) != 10 {
		t.Fatalf("after delete line of offset 55 is %d", m.VisualLineFromCharOffset(55))
	}
}

func TestZeroHeightUsesFallback(t *testing.T) {
	m := New()
	m.PushLine(4, 0, false)
	frame := m.BuildViewportFrame(-1, 0, 0.2)
	if len(frame.Lines) != 1 || frame.Lines[0].Height != 1 {
		t.Fatalf("fallback %+v frame=%+v", frame.Lines, frame)
	}
}
