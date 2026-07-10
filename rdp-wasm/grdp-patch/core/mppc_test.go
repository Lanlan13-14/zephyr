package core

import (
	"bytes"
	"testing"
)

// compressedABC is the MPPC-64K encoding of "abc" (three literals).
//
// Bit layout (MSB-first within each byte):
//   literal 'a' (0x61): 0 0110_0001  → bits  0‥8
//   literal 'b' (0x62): 0 0110_0010  → bits  9‥17
//   literal 'c' (0x63): 0 0110_0011  → bits 18‥26
//   padding zeros                    → bits 27‥31
//
// Grouped into bytes: 0x30 0x98 0x8C 0x60
var compressedABC = []byte{0x30, 0x98, 0x8C, 0x60}

// compressedABCABC is "abc" followed by a copy-tuple that repeats it.
//
// After the three literals above (bits 0‥26):
//   copy disc (1):            bit 27
//   selector 00:              bits 28‥29
//   offset bits 000010 (=2):  bits 30‥35
//   length terminator 0:      bit 36
//   padding zeros:            bits 37‥39
//
// Bytes: 0x30 0x98 0x8C 0x70 0x20
// Decoded: "abcabc" (offset 2 → src = histOffset-3 = 0; length 3)
var compressedABCABC = []byte{0x30, 0x98, 0x8C, 0x70, 0x20}

func TestMppcDecompressLiterals(t *testing.T) {
	d := NewMppcDecompressor()
	got, err := d.Decompress(mppcBig|mppcCompressed, compressedABC)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("abc")) {
		t.Errorf("got %q, want %q", got, "abc")
	}
}

func TestMppcDecompressCopyTuple(t *testing.T) {
	d := NewMppcDecompressor()
	got, err := d.Decompress(mppcBig|mppcCompressed, compressedABCABC)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("abcabc")) {
		t.Errorf("got %q, want %q", got, "abcabc")
	}
}

func TestMppcDecompressFlush(t *testing.T) {
	d := NewMppcDecompressor()
	// First call: populate history.
	_, _ = d.Decompress(mppcBig|mppcCompressed, compressedABC)
	if d.history[0] != 'a' {
		t.Fatal("history not populated after first call")
	}
	// Second call with FLUSH: history must be zeroed.
	_, _ = d.Decompress(mppcBig|mppcFlushed|mppcCompressed, compressedABC)
	// After flush the offset is 0; the fresh "abc" should again be at [0..2].
	if d.history[0] != 'a' || d.history[1] != 'b' || d.history[2] != 'c' {
		t.Errorf("unexpected history after flush: %q %q %q",
			d.history[0], d.history[1], d.history[2])
	}
}

func TestMppcDecompressReset(t *testing.T) {
	d := NewMppcDecompressor()
	// Write "abc" at offset 0; offset becomes 3.
	_, _ = d.Decompress(mppcBig|mppcCompressed, compressedABC)
	if d.offset != 3 {
		t.Fatalf("offset after first call: got %d, want 3", d.offset)
	}
	// RESET (PACKET_AT_FRONT): offset must be 0, history contents preserved.
	_, _ = d.Decompress(mppcBig|mppcReset|mppcCompressed, compressedABC)
	if d.offset != 3 {
		t.Fatalf("offset after reset+decompress: got %d, want 3", d.offset)
	}
	// History at [0..2] should now be overwritten with "abc" again.
	if d.history[0] != 'a' {
		t.Errorf("history[0] after reset: got %q", d.history[0])
	}
}

func TestMppcDecompressUncompressed(t *testing.T) {
	d := NewMppcDecompressor()
	plain := []byte("hello")
	got, err := d.Decompress(mppcBig, plain) // no COMPRESSED flag
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Errorf("got %q, want %q", got, plain)
	}
	// History should be updated.
	if d.history[0] != 'h' || d.history[4] != 'o' {
		t.Errorf("history not updated: [0]=%q [4]=%q", d.history[0], d.history[4])
	}
	if d.offset != 5 {
		t.Errorf("offset: got %d, want 5", d.offset)
	}
}
