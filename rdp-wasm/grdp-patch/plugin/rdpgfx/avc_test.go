package rdpgfx

import (
	"encoding/binary"
	"testing"
)

func TestParseAVC420Stream(t *testing.T) {
	data := make([]byte, 4+10+4)
	binary.LittleEndian.PutUint32(data[:4], 1)
	binary.LittleEndian.PutUint16(data[4:], 10)
	binary.LittleEndian.PutUint16(data[6:], 20)
	binary.LittleEndian.PutUint16(data[8:], 110)
	binary.LittleEndian.PutUint16(data[10:], 220)
	data[12] = 0x41
	data[13] = 0x7F
	copy(data[14:], []byte{0x00, 0x00, 0x01, 0x65})

	stream, err := parseAVC420Stream(data)
	if err != nil {
		t.Fatalf("parseAVC420Stream returned error: %v", err)
	}
	if len(stream.regions) != 1 {
		t.Fatalf("expected 1 region, got %d", len(stream.regions))
	}
	got := stream.regions[0]
	if got.left != 10 || got.top != 20 || got.right != 110 || got.bottom != 220 {
		t.Fatalf("unexpected region: %+v", got)
	}
	if string(stream.h264Data) != string([]byte{0x00, 0x00, 0x01, 0x65}) {
		t.Fatalf("unexpected h264 payload: %v", stream.h264Data)
	}
}

func TestParseAVC420StreamReadsContiguousRectArrayBeforeQuantQuality(t *testing.T) {
	// MS-RDPEGFX RDPGFX_H264_METABLOCK stores all 8-byte rectangles first,
	// followed by a separate 2-byte quant/quality pair for every rectangle.
	// The rectangles are not interleaved with their quant/quality values.
	data := make([]byte, 4+2*8+2*2+4)
	binary.LittleEndian.PutUint32(data[:4], 2)
	binary.LittleEndian.PutUint16(data[4:], 1)
	binary.LittleEndian.PutUint16(data[6:], 2)
	binary.LittleEndian.PutUint16(data[8:], 101)
	binary.LittleEndian.PutUint16(data[10:], 102)
	binary.LittleEndian.PutUint16(data[12:], 11)
	binary.LittleEndian.PutUint16(data[14:], 12)
	binary.LittleEndian.PutUint16(data[16:], 111)
	binary.LittleEndian.PutUint16(data[18:], 112)
	data[20], data[21] = 0x41, 0x7f
	data[22], data[23] = 0x42, 0x6f
	copy(data[24:], []byte{0x00, 0x00, 0x01, 0x65})

	stream, err := parseAVC420Stream(data)
	if err != nil {
		t.Fatalf("parseAVC420Stream returned error: %v", err)
	}
	want := []avcRect{
		{left: 1, top: 2, right: 101, bottom: 102},
		{left: 11, top: 12, right: 111, bottom: 112},
	}
	if len(stream.regions) != len(want) {
		t.Fatalf("expected %d regions, got %d", len(want), len(stream.regions))
	}
	for i := range want {
		if stream.regions[i] != want[i] {
			t.Fatalf("region %d: got %+v, want %+v", i, stream.regions[i], want[i])
		}
	}
	if string(stream.h264Data) != string([]byte{0x00, 0x00, 0x01, 0x65}) {
		t.Fatalf("unexpected h264 payload: %v", stream.h264Data)
	}
}
