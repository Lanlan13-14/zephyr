package rdpgfx

import (
	"encoding/binary"
	"testing"
)

func TestSurfaceToCacheAndCacheToSurfaceRoundTrip(t *testing.T) {
	handler := &GfxHandler{surfaces: make(map[uint16]*surface), cacheEntries: make(map[uint16]cacheEntry)}
	src := &surface{id: 1, width: 2, height: 2, data: []byte{
		1, 2, 3, 4, 5, 6, 7, 8,
		9, 10, 11, 12, 13, 14, 15, 16,
	}}
	dst := &surface{id: 2, width: 2, height: 2, data: make([]byte, 16)}
	handler.surfaces[1] = src
	handler.surfaces[2] = dst
	pdu := make([]byte, 20)
	binary.LittleEndian.PutUint16(pdu[0:], 1)
	binary.LittleEndian.PutUint16(pdu[10:], 7)
	binary.LittleEndian.PutUint16(pdu[12:], 0)
	binary.LittleEndian.PutUint16(pdu[14:], 0)
	binary.LittleEndian.PutUint16(pdu[16:], 2)
	binary.LittleEndian.PutUint16(pdu[18:], 2)
	handler.onSurfaceToCache(pdu)
	entry, ok := handler.cacheEntries[7]
	if !ok || entry.width != 2 || entry.height != 2 {
		t.Fatalf("cache entry missing: %+v", entry)
	}
	copyPDU := make([]byte, 10)
	binary.LittleEndian.PutUint16(copyPDU[0:], 7)
	binary.LittleEndian.PutUint16(copyPDU[2:], 2)
	binary.LittleEndian.PutUint16(copyPDU[4:], 1)
	handler.onCacheToSurface(copyPDU)
	for i := range src.data {
		if dst.data[i] != src.data[i] {
			t.Fatalf("pixel %d differs: got %d want %d", i, dst.data[i], src.data[i])
		}
	}
}

func TestSurfaceToCacheClampsRect(t *testing.T) {
	handler := &GfxHandler{surfaces: map[uint16]*surface{1: {id: 1, width: 1, height: 1, data: []byte{1, 2, 3, 4}}}, cacheEntries: make(map[uint16]cacheEntry)}
	pdu := make([]byte, 20)
	binary.LittleEndian.PutUint16(pdu[0:], 1)
	binary.LittleEndian.PutUint16(pdu[10:], 3)
	binary.LittleEndian.PutUint16(pdu[16:], 9)
	binary.LittleEndian.PutUint16(pdu[18:], 9)
	handler.onSurfaceToCache(pdu)
	if got := handler.cacheEntries[3].data; len(got) != 4 {
		t.Fatalf("clamped cache data length=%d, want 4", len(got))
	}
}
