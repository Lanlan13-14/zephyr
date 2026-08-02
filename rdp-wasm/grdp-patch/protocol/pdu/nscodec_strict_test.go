package pdu

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestNRLEDecodeRejectsTruncatedInput(t *testing.T) {
	out := make([]byte, 8)
	if err := nrleDecodeInto([]byte{1, 2, 3}, out); err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("expected truncation error, got %v", err)
	}
}

func TestNRLEDecodeRejectsOversizedRun(t *testing.T) {
	out := make([]byte, 8)
	// A short run length byte of 7 encodes nine output bytes, but only eight
	// bytes remain. FreeRDP treats this as a hard decode failure.
	if err := nrleDecodeInto([]byte{0xAA, 0xAA, 7, 1, 2, 3, 4}, out); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected oversized run error, got %v", err)
	}
}

func TestNRLEDecodeValidRunAndRawTail(t *testing.T) {
	out := make([]byte, 8)
	if err := nrleDecodeInto([]byte{0xAA, 0xAA, 2, 1, 2, 3, 4}, out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := []byte{0xAA, 0xAA, 0xAA, 0xAA, 1, 2, 3, 4}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("output[%d]=%d want %d (all=%v)", i, out[i], want[i], out)
		}
	}
}

func TestNSCodecRejectsMalformedPooledPlaneAtomically(t *testing.T) {
	valid := make([]byte, 20+12)
	binary.LittleEndian.PutUint32(valid[0:4], 4)
	binary.LittleEndian.PutUint32(valid[4:8], 4)
	binary.LittleEndian.PutUint32(valid[8:12], 4)
	valid[16] = 1 // color loss level
	copy(valid[20:], []byte{
		200, 200, 200, 200, // Y
		0, 0, 0, 0, // Co
		0, 0, 0, 0, // Cg
	})
	if pixels, err := DecodeNSCodec(valid, 2, 2); err != nil || len(pixels) != 16 {
		t.Fatalf("prime pooled planes: len=%d err=%v", len(pixels), err)
	}

	malformed := make([]byte, 20+9)
	binary.LittleEndian.PutUint32(malformed[0:4], 1) // compressed Y, truncated NRLE
	binary.LittleEndian.PutUint32(malformed[4:8], 4)
	binary.LittleEndian.PutUint32(malformed[8:12], 4)
	malformed[16] = 1
	copy(malformed[20:], []byte{200, 0, 0, 0, 0, 0, 0, 0, 0})
	pixels, err := DecodeNSCodec(malformed, 2, 2)
	if err == nil || pixels != nil {
		t.Fatalf("malformed pooled decode must be atomic: len=%d err=%v", len(pixels), err)
	}
}

func TestNSCodecRejectsPlaneLengthOverflow(t *testing.T) {
	data := make([]byte, 20)
	for off := 0; off < 16; off += 4 {
		binary.LittleEndian.PutUint32(data[off:off+4], ^uint32(0))
	}
	data[16] = 1
	if pixels, err := DecodeNSCodec(data, 2, 2); err == nil || pixels != nil {
		t.Fatalf("overflowed plane lengths must fail: len=%d err=%v", len(pixels), err)
	}
}
