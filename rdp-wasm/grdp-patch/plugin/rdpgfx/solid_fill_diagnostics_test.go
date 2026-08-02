package rdpgfx

import (
	"encoding/binary"
	"testing"
)

func TestSolidFillReportsLargeChromaGreenWithBoundedKey(t *testing.T) {
	g := NewGfxHandler(nil)
	t.Cleanup(g.Close)
	g.surfaces[7] = &surface{id: 7, width: 100, height: 100, data: make([]byte, 100*100*4)}

	var events []string
	g.SetProtocolObserver(func(event string) { events = append(events, event) })
	data := make([]byte, 16)
	binary.LittleEndian.PutUint16(data[0:2], 7)
	data[2] = 0
	data[3] = 255
	data[4] = 0
	binary.LittleEndian.PutUint16(data[6:8], 1)
	binary.LittleEndian.PutUint16(data[8:10], 0)
	binary.LittleEndian.PutUint16(data[10:12], 0)
	binary.LittleEndian.PutUint16(data[12:14], 100)
	binary.LittleEndian.PutUint16(data[14:16], 50)

	g.onSolidFill(data)

	if len(events) != 1 || events[0] != "rdpgfx.solidfill.chroma-green.large" {
		t.Fatalf("unexpected solid-fill diagnostics: %v", events)
	}
}

func TestSolidFillRejectsInvertedRectangle(t *testing.T) {
	g := NewGfxHandler(nil)
	t.Cleanup(g.Close)
	g.surfaces[8] = &surface{id: 8, width: 10, height: 10, data: make([]byte, 10*10*4)}

	var renderEvents int
	g.SetRenderEventSink(func(RenderEvent) { renderEvents++ })
	data := make([]byte, 16)
	binary.LittleEndian.PutUint16(data[0:2], 8)
	binary.LittleEndian.PutUint16(data[6:8], 1)
	binary.LittleEndian.PutUint16(data[8:10], 9)
	binary.LittleEndian.PutUint16(data[10:12], 9)
	binary.LittleEndian.PutUint16(data[12:14], 1)
	binary.LittleEndian.PutUint16(data[14:16], 1)

	g.onSolidFill(data)
	if renderEvents != 0 {
		t.Fatalf("inverted rectangle emitted %d render events", renderEvents)
	}
}
