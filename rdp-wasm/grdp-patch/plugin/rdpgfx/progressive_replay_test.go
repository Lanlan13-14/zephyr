package rdpgfx

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func replayFNV(data []byte) uint64 {
	var h uint64 = 1469598103934665603
	for _, b := range data {
		h ^= uint64(b)
		h *= 1099511628211
	}
	return h
}

// TestProgressiveOfflineReplay decodes the captured live WTS2 Progressive
// sequence in the same persistent-surface order as the protocol. The raw
// output files are compared outside Go with FreeRDP's progressive_decompress_ex.
func TestProgressiveOfflineReplay(t *testing.T) {
	dir := os.Getenv("PROGRESSIVE_REPLAY_DIR")
	if dir == "" {
		t.Skip("PROGRESSIVE_REPLAY_DIR not set")
	}
	const width, height = 1080, 1990
	surface := make([]byte, width*height*4)
	decoder := newRfxProgressiveDecoder()
	for i := 0; i < 32; i++ {
		metaPath := filepath.Join(dir, fmt.Sprintf("%02d.meta", i))
		mf, err := os.Open(metaPath)
		if err != nil {
			if os.IsNotExist(err) {
				break
			}
			t.Fatal(err)
		}
		var mw, mh, frame, codec, ctxID, expectedRects int
		_, err = fmt.Fscan(mf, &mw, &mh, &frame, &codec, &ctxID, &expectedRects)
		mf.Close()
		if err != nil {
			t.Fatal(err)
		}
		if mw != width || mh != height || codec != 9 {
			t.Fatalf("%02d metadata=%dx%d codec=%d", i, mw, mh, codec)
		}
		payload, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("%02d.bin", i)))
		if err != nil {
			t.Fatal(err)
		}
		rects := decoder.Decode(payload, surface, width, height)
		outPath := filepath.Join("/tmp", fmt.Sprintf("progressive_go_%02d.raw", i))
		if err := os.WriteFile(outPath, surface, 0o644); err != nil {
			t.Fatal(err)
		}
		fmt.Printf("%02d frame=%d payload=%d go_rects=%d expected_rects=%d fnv=%016x output=%s\n", i, frame, len(payload), len(rects), expectedRects, replayFNV(surface), outPath)
	}
}
