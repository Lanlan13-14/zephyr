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
