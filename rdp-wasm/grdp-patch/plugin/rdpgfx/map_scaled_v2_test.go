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

func TestMapSurfaceDoesNotReplayShadowIntoRenderSink(t *testing.T) {
	g := NewGfxHandler(nil)
	t.Cleanup(g.Close)
	g.surfaces[3] = &surface{
		id:          3,
		width:       64,
		height:      48,
		data:        make([]byte, 64*48*4),
		shadowStale: true,
	}

	var kinds []RenderEventKind
	g.SetRenderEventSink(func(e RenderEvent) { kinds = append(kinds, e.Kind) })

	data := make([]byte, 12)
	binary.LittleEndian.PutUint16(data[0:2], 3)
	binary.LittleEndian.PutUint32(data[4:8], 11)
	binary.LittleEndian.PutUint32(data[8:12], 22)
	g.onMapSurfaceToOutput(data)

	if len(kinds) != 1 || kinds[0] != RenderMapSurface {
		t.Fatalf("map must emit only the mapping event, got %v", kinds)
	}
}

func TestScaledMapDoesNotReplayFreshShadowIntoRenderSink(t *testing.T) {
	g := NewGfxHandler(nil)
	t.Cleanup(g.Close)
	g.surfaces[4] = &surface{
		id:          4,
		width:       64,
		height:      48,
		data:        make([]byte, 64*48*4),
		shadowStale: false,
	}

	var kinds []RenderEventKind
	g.SetRenderEventSink(func(e RenderEvent) { kinds = append(kinds, e.Kind) })

	data := make([]byte, 20)
	binary.LittleEndian.PutUint16(data[0:2], 4)
	binary.LittleEndian.PutUint32(data[12:16], 128)
	binary.LittleEndian.PutUint32(data[16:20], 96)
	g.onMapSurfaceToScaledOutput(data)

	if len(kinds) != 1 || kinds[0] != RenderMapSurfaceScaled {
		t.Fatalf("scaled map must emit only the mapping event, got %v", kinds)
	}
}

func TestMapRepaintsOnlyFreshLegacyShadow(t *testing.T) {
	updates := 0
	g := NewGfxHandler(func(got []BitmapUpdate) { updates += len(got) })
	t.Cleanup(g.Close)
	s := &surface{id: 5, width: 2, height: 2, data: make([]byte, 16), shadowStale: true}
	g.surfaces[5] = s

	data := make([]byte, 12)
	binary.LittleEndian.PutUint16(data[0:2], 5)
	g.onMapSurfaceToOutput(data)
	if updates != 0 {
		t.Fatalf("stale legacy shadow was replayed: updates=%d", updates)
	}

	s.shadowStale = false
	g.onMapSurfaceToOutput(data)
	if updates != 1 {
		t.Fatalf("fresh legacy shadow was not replayed: updates=%d", updates)
	}
}
