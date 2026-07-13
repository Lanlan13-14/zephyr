package rdpgfx

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
	"testing"
)

func TestWireToSurface1ClearCodecWritesSurface(t *testing.T) {
	payload, err := os.ReadFile("testdata/clear2.bin")
	if err != nil {
		t.Fatal(err)
	}
	g := NewGfxHandler(nil)
	g.surfaces[5] = &surface{id: 5, width: 100, height: 40, format: 0x20, data: make([]byte, 100*40*4)}
	var semantic RenderEvent
	g.SetRenderEventSink(func(event RenderEvent) {
		if event.Kind == RenderBitmap {
			semantic = event
		}
	})
	pdu := make([]byte, 17+len(payload))
	binary.LittleEndian.PutUint16(pdu[0:2], 5)
	binary.LittleEndian.PutUint16(pdu[2:4], codecClear)
	pdu[4] = 0x20
	binary.LittleEndian.PutUint16(pdu[5:7], 11)
	binary.LittleEndian.PutUint16(pdu[7:9], 7)
	binary.LittleEndian.PutUint16(pdu[9:11], 89)
	binary.LittleEndian.PutUint16(pdu[11:13], 24)
	binary.LittleEndian.PutUint32(pdu[13:17], uint32(len(payload)))
	copy(pdu[17:], payload)
	g.onWireToSurface1Decode(pdu)
	if semantic.Kind != RenderBitmap {
		t.Fatalf("no RenderBitmap event: %#v", semantic)
	}
	if semantic.Rect != (RenderRect{Left: 11, Top: 7, Right: 89, Bottom: 24}) {
		t.Fatalf("rect=%#v", semantic.Rect)
	}
	want := [32]byte{0x57, 0xcc, 0x2c, 0xdf, 0x27, 0xca, 0x1c, 0xa2, 0x77, 0x56, 0xa6, 0x06, 0x62, 0xcb, 0x84, 0x2d, 0xec, 0x80, 0x9f, 0x2a, 0xe5, 0xcc, 0x1b, 0x3c, 0xe3, 0x4d, 0x3b, 0xfe, 0x38, 0x9a, 0x27, 0x5a}
	gotRegion := make([]byte, 78*17*4)
	s := g.surfaces[5]
	for y := 0; y < 17; y++ {
		copy(gotRegion[y*78*4:(y+1)*78*4], s.data[(7+y)*100*4+11*4:(7+y)*100*4+89*4])
	}
	got := sha256.Sum256(gotRegion)
	if got != want {
		t.Fatalf("surface hash=%x want=%x", got, want)
	}
}
