package selection

import "testing"

func TestCollapsedToReplacementEnd(t *testing.T) {
	got := Replace(2, 5, 1, false, State{Base: 1, Extent: 4}, 6)
	if got != (State{Base: 3, Extent: 3}) {
		t.Fatalf("%+v", got)
	}
}

func TestPreserveBeforeInsideAndAfter(t *testing.T) {
	// delete [2,5), insert 1 scalar. delta = -2.
	got := Replace(2, 5, 1, true, State{Base: 1, Extent: 3}, 6)
	if got.Base != 1 || got.Extent != 3 {
		t.Fatalf("before/inside %+v", got)
	}
	got = Replace(2, 5, 1, true, State{Base: 6, Extent: 5}, 6)
	if got.Base != 4 || got.Extent != 3 {
		t.Fatalf("after/edge %+v", got)
	}
}

func TestClamp(t *testing.T) {
	if (State{Base: -2, Extent: 9}).Clamp(4) != (State{Base: 0, Extent: 4}) {
		t.Fatal("clamp")
	}
}
