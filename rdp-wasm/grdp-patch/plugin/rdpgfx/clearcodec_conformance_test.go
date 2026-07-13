package rdpgfx

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

func TestClearCodecMicrosoftFixtures(t *testing.T) {
	tests := []struct {
		name   string
		file   string
		width  int
		height int
		sha256 string
	}{
		{"example2", "testdata/clear2.bin", 78, 17, "57cc2cdf27ca1ca27756a60662cb842dec809f2ae5cc1b3ce34d3bfe389a275a"},
		{"example3", "testdata/clear3.bin", 64, 24, "aada201c62d5d2039a94c17a289e4de567b895182ef5eada880d74c59413f5f5"},
		{"example4", "testdata/clear4.bin", 7, 15, "1dc822be6171d15f8b6cf5bba6d34a6090cba45ed688887d980a2e4ad6a2f21c"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			input, err := os.ReadFile(tc.file)
			if err != nil {
				t.Fatal(err)
			}
			got, err := newClearDecoder().decode(input, tc.width, tc.height)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(got) != tc.width*tc.height*4 {
				t.Fatalf("output length=%d want=%d", len(got), tc.width*tc.height*4)
			}
			sum := sha256.Sum256(got)
			if hex.EncodeToString(sum[:]) != tc.sha256 {
				_ = os.WriteFile("/tmp/clear-"+tc.name+"-got.bgra", got, 0o644)
				limit := min(64, len(got))
				t.Logf("first pixels=%x", got[:limit])
				t.Fatalf("pixel sha256=%x want=%s", sum, tc.sha256)
			}
		})
	}
}
