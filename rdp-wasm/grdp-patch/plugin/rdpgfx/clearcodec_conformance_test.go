package rdpgfx

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

// Reference hashes are RGB-only sha256 of FreeRDP 2.11 clear_decompress
// output (PIXEL_FORMAT_BGRX32) over the same fixtures — the alpha/X byte is
// undefined in the XRGB formats and legitimately differs between
// implementations. Computed offline with libfreerdp2.
func TestClearCodecMicrosoftFixtures(t *testing.T) {
	tests := []struct {
		name   string
		file   string
		width  int
		height int
		sha256 string
	}{
		{"example2", "testdata/clear2.bin", 78, 17, "3228ff1d9fbb28654313c92b34397ff4f6a0963056977e0d2f15d18db3879c28"},
		{"example3", "testdata/clear3.bin", 64, 24, "286da6995042d3e8f38aad934ccca5ab08d1f85a7f78d3fc0d9b00894695d3f5"},
		{"example4", "testdata/clear4.bin", 7, 15, "b11143e12df0744df96e50be3a45f754c87caf4bf5e1c73a7db5fa23bee5de22"},
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
			rgb := make([]byte, 0, tc.width*tc.height*3)
			for i := 0; i < len(got); i += 4 {
				rgb = append(rgb, got[i], got[i+1], got[i+2])
			}
			sum := sha256.Sum256(rgb)
			if hex.EncodeToString(sum[:]) != tc.sha256 {
				_ = os.WriteFile("/tmp/clear-"+tc.name+"-got.bgra", got, 0o644)
				limit := min(64, len(got))
				t.Logf("first pixels=%x", got[:limit])
				t.Fatalf("rgb sha256=%x want=%s", sum, tc.sha256)
			}
		})
	}
}
