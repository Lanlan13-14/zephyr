package folds

import "testing"

func TestNestedAndSameLine(t *testing.T) {
	text := []rune("{\n(\n)\n}\n[]")
	got := Compute(text)
	if len(got) != 2 || got[0] != (Range{1, 2}) || got[1] != (Range{0, 3}) {
		t.Fatalf("%+v", got)
	}
}

func TestMismatchPopsWithoutFold(t *testing.T) {
	got := Compute([]rune("{\n]\n}"))
	if len(got) != 0 {
		t.Fatalf("mismatched closer must consume the opener, got %+v", got)
	}
}

func TestCRLFCountsOnlyLF(t *testing.T) {
	got := Compute([]rune("(a\r\nb)"))
	if len(got) != 1 || got[0] != (Range{0, 1}) {
		t.Fatalf("%+v", got)
	}
}
