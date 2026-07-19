package rdpgfx

import (
	"math/rand"
	"testing"
)

func TestPdSrlEncoderRoundTrip(t *testing.T) {
	cases := []struct {
		vals []int16
		nbs  []int
	}{
		{[]int16{1, -1, 0, 0, 2, -3, 0, 1}, []int{1, 1, 2, 2, 2, 2, 3, 3}},
		{make([]int16, 257), fillInts(257, 3)},
	}
	rng := rand.New(rand.NewSource(991))
	for c := 0; c < 80; c++ {
		n := 1 + rng.Intn(1200)
		vals := make([]int16, n)
		nbs := make([]int, n)
		for i := range vals {
			nb := 1 + rng.Intn(5)
			nbs[i] = nb
			if rng.Intn(100) < 72 {
				continue
			}
			max := (1 << nb) - 1
			v := 1 + rng.Intn(max)
			if rng.Intn(2) == 0 {
				v = -v
			}
			vals[i] = int16(v)
		}
		cases = append(cases, struct {
			vals []int16
			nbs  []int
		}{vals, nbs})
	}
	for ci, tc := range cases {
		e := newPdSrlEncoder()
		e.encodeSrlSeq(tc.vals, tc.nbs)
		state := newRfxSrlState(e.srl.buf, nil)
		for i, want := range tc.vals {
			if got := rfxSrlRead(state, tc.nbs[i]); got != want {
				t.Fatalf("case=%d index=%d nb=%d got=%d want=%d bits=%d", ci, i, tc.nbs[i], got, want, state.srl.bitPos)
			}
		}
	}
}

func fillInts(n, v int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = v
	}
	return out
}
