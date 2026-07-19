package rdpgfx

import "testing"

func TestIctFreeRDPNarrowing(t *testing.T) {
	cases := []struct {
		y, cb, cr int16
		want      [4]byte
	}{
		{0, 0, 0, [4]byte{128, 128, 128, 0xFF}},
		{-13728, 0, 0, [4]byte{0, 0, 0, 0xFF}},
		{18060, 0, 0, [4]byte{255, 255, 255, 0xFF}},
		{0, 32767, -32768, [4]byte{0, 255, 255, 0xFF}},
	}
	for _, tc := range cases {
		dst := [4]byte{0, 0, 0, 0}
		ictToBGRA([]int16{tc.y}, []int16{tc.cb}, []int16{tc.cr}, dst[:], 1)
		if dst != tc.want {
			t.Fatalf("ict(%d,%d,%d)=%v want %v", tc.y, tc.cb, tc.cr, dst, tc.want)
		}
	}
}
