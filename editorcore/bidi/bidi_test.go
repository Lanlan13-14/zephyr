package bidi

import "testing"

func TestShortRTLIsNotForcedLTR(t *testing.T) {
	// Fewer than 32 scalars, and not ASCII. The Rust shortcut would report one
	// LTR segment; the real classes split.
	text := []rune("aאב b")
	segs := Segments(text, 0)
	if len(segs) != 3 {
		t.Fatalf("segments %+v", segs)
	}
	if segs[0].Direction != LTR || segs[0].Start != 0 || segs[0].End != 1 {
		t.Fatalf("ltr segment %+v", segs[0])
	}
	if segs[1].Direction != RTL || segs[1].Start != 1 || segs[1].End != 4 {
		t.Fatalf("rtl segment %+v", segs[1])
	}
	if segs[2].Direction != LTR || segs[2].Start != 4 || segs[2].End != len(text) {
		t.Fatalf("trailing ltr %+v", segs[2])
	}
	if DocumentDirection(text) != Mixed {
		t.Fatal("expected mixed")
	}
	if PrimaryDirection(text) != LTR {
		t.Fatal("two LTR scalars tie-break over two RTL scalars toward LTR")
	}
	if PrimaryDirection([]rune("aאב")) != RTL {
		t.Fatal("two RTL scalars outvote one LTR scalar")
	}
}

func TestEuropeanNumberIsNeutral(t *testing.T) {
	if ClassOf('5') != Neutral || ClassOf(' ') != Neutral || ClassOf('.') != Neutral {
		t.Fatal("EN/WS/CS must not form a segment")
	}
	if ClassOf('A') != LTR || ClassOf('א') != RTL || ClassOf('٥') != RTL {
		t.Fatal("strong classes misread")
	}
	segs := Segments([]rune("12"), 4)
	if len(segs) != 0 {
		t.Fatalf("digits produced %+v", segs)
	}
}

func TestNoStrongIsLTRDocument(t *testing.T) {
	text := []rune("... 12")
	if DocumentDirection(text) != LTR || PrimaryDirection(text) != LTR {
		t.Fatal("neutral document is LTR")
	}
	if DocumentDirection([]rune("אב")) != RTL {
		t.Fatal("pure RTL")
	}
}

func TestTieIsLTR(t *testing.T) {
	if PrimaryDirection([]rune("aא")) != LTR {
		t.Fatal("tie must be LTR")
	}
}

func TestOffsetBase(t *testing.T) {
	segs := Segments([]rune("אa"), 10)
	if segs[0].Start != 10 || segs[0].End != 11 || segs[1].Start != 11 || segs[1].End != 12 {
		t.Fatalf("%+v", segs)
	}
}
