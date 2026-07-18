package rdpgfx

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Offline ClearCodec replay harness. Point CLEAR_REPLAY_DIR at a directory of
// captured payloads (NNN.bin + NNN.meta "w h frameId err") and it decodes
// each stream in order, printing hash/error per stream. The same payloads
// can be fed to FreeRDP's clear.c for a byte-exact differential.
func TestClearCodecOfflineReplay(t *testing.T) {
	dir := os.Getenv("CLEAR_REPLAY_DIR")
	if dir == "" {
		t.Skip("CLEAR_REPLAY_DIR not set")
	}
	bins, err := filepath.Glob(filepath.Join(dir, "*.bin"))
	if err != nil || len(bins) == 0 {
		t.Fatalf("no payloads in %s: %v", dir, err)
	}
	d := newClearDecoder()
	for _, bin := range bins {
		base := strings.TrimSuffix(bin, ".bin")
		metaB, err := os.ReadFile(base + ".meta")
		if err != nil {
			t.Fatalf("meta for %s: %v", bin, err)
		}
		parts := strings.Fields(string(metaB))
		w, _ := strconv.Atoi(parts[0])
		h, _ := strconv.Atoi(parts[1])
		data, err := os.ReadFile(bin)
		if err != nil {
			t.Fatalf("read %s: %v", bin, err)
		}
		out, derr := d.decode(data, w, h)
		if derr != nil {
			fmt.Printf("%s rc=ERR %v\n", filepath.Base(base), derr)
			continue
		}
		h64 := uint64(1469598103934665603)
		for _, b := range out {
			h64 ^= uint64(b)
			h64 *= 1099511628211
		}
		if werr := os.WriteFile(base+".go", out, 0o644); werr != nil {
			t.Fatal(werr)
		}
		fmt.Printf("%s rc=OK hash=%x warns=%v\n", filepath.Base(base), h64, d.takeWarns())
	}
}
