package rdpgfx

import (
	"encoding/binary"
	"testing"
)

func TestMapSurfaceToScaledOutputV2Fields(t *testing.T) {
	g := NewGfxHandler(nil)
	g.surfaces[9] = &surface{id: 9, width: 1920, height: 1080, data: make([]byte, 1920*1080*4)}
	var got RenderEvent
	g.SetRenderEventSink(func(e RenderEvent) {
		if e.Kind == RenderMapSurfaceScaled {
			got = e
		}
	})
	data := make([]byte, 20)
	binary.LittleEndian.PutUint16(data[0:2], 9)
	binary.LittleEndian.PutUint16(data[2:4], 0)           // reserved
	binary.LittleEndian.PutUint32(data[4:8], 0xFFFF_FFF6) // -10
	binary.LittleEndian.PutUint32(data[8:12], 20)
	binary.LittleEndian.PutUint32(data[12:16], 1920)
	binary.LittleEndian.PutUint32(data[16:20], 1080)
	g.onMapSurfaceToScaledOutput(data)
	if got.Kind != RenderMapSurfaceScaled || got.SurfaceID != 9 || int32(got.OutputX) != -10 || got.OutputY != 20 || got.Width != 1920 || got.Height != 1080 {
		t.Fatalf("bad scaled map event: %+v", got)
	}
}
