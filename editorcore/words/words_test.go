package words

import (
	"strings"
	"testing"
)

func TestOrderAndWordChars(t *testing.T) {
	got := Extract([]rune("b a_b a_b foo-bar 中文 --"))
	want := []string{"b", "a_b", "foo-bar", "中文", "--"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%#v", got)
	}
}

func TestCapKeepsFirstSeen(t *testing.T) {
	var b []rune
	for i := 0; i < 5002; i++ {
		b = append(b, rune('a'+i%26))
		b = append(b, ' ')
	}
	got := Extract(b)
	if len(got) != 26 {
		t.Fatalf("unique %d", len(got))
	}
	// Force the cap with distinct words.
	parts := make([]string, 0, 5001)
	for i := 0; i < 5001; i++ {
		parts = append(parts, "w"+itoa(i))
	}
	got = Extract([]rune(strings.Join(parts, " ")))
	if len(got) != 5000 || got[0] != "w0" || got[4999] != "w4999" {
		t.Fatalf("len %d first %s last %s", len(got), got[0], got[len(got)-1])
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d [8]byte
	i := len(d)
	for n > 0 {
		i--
		d[i] = byte('0' + n%10)
		n /= 10
	}
	return string(d[i:])
}
