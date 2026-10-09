package brackets

import "testing"

func TestNestedForwardAndBack(t *testing.T) {
	text := []rune("a(b(c)d)e")
	if Match(text, 1) != 7 || Match(text, 7) != 1 || Match(text, 3) != 5 {
		t.Fatalf("matches %d %d %d", Match(text, 1), Match(text, 7), Match(text, 3))
	}
}

func TestNoPartner(t *testing.T) {
	if Match([]rune("()"), 2) != -1 || Match([]rune("("), 0) != -1 || Match([]rune("x"), 0) != -1 {
		t.Fatal("expected no partner")
	}
}
