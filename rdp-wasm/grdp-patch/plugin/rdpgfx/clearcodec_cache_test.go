package rdpgfx

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
	"testing"
)

func TestClearCodecSurfaceCacheRoundTrip(t *testing.T) {
	payload, err := os.ReadFile("testdata/clear2.bin")
	if err != nil {
		t.Fatal(err)
	}
	g := NewGfxHandler(nil)
	g.surfaces[5] = &surface{id: 5, width: 100, height: 40, format: 0x20, data: make([]byte, 100*40*4)}
	g.surfaces[6] = &surface{id: 6, width: 120, height: 50, format: 0x20, data: make([]byte, 120*50*4)}

	wts := make([]byte, 17+len(payload))
	binary.LittleEndian.PutUint16(wts[0:2], 5)
	binary.LittleEndian.PutUint16(wts[2:4], codecClear)
	wts[4] = 0x20
	binary.LittleEndian.PutUint16(wts[5:7], 11)
	binary.LittleEndian.PutUint16(wts[7:9], 7)
	binary.LittleEndian.PutUint16(wts[9:11], 89)
	binary.LittleEndian.PutUint16(wts[11:13], 24)
	binary.LittleEndian.PutUint32(wts[13:17], uint32(len(payload)))
	copy(wts[17:], payload)
	g.onWireToSurface1Decode(wts)

	s2c := make([]byte, 20)
	binary.LittleEndian.PutUint16(s2c[0:], 5)
	binary.LittleEndian.PutUint64(s2c[2:], 0x1122334455667788)
	binary.LittleEndian.PutUint16(s2c[10:], 42)
	binary.LittleEndian.PutUint16(s2c[12:], 11)
	binary.LittleEndian.PutUint16(s2c[14:], 7)
	binary.LittleEndian.PutUint16(s2c[16:], 89)
	binary.LittleEndian.PutUint16(s2c[18:], 24)
	g.onSurfaceToCache(s2c)
	ce, ok := g.cacheEntries[42]
	if !ok || ce.width != 78 || ce.height != 17 {
		t.Fatalf("cache entry=%+v ok=%v", ce, ok)
	}
	want := [32]byte{0x57, 0xcc, 0x2c, 0xdf, 0x27, 0xca, 0x1c, 0xa2, 0x77, 0x56, 0xa6, 0x06, 0x62, 0xcb, 0x84, 0x2d, 0xec, 0x80, 0x9f, 0x2a, 0xe5, 0xcc, 0x1b, 0x3c, 0xe3, 0x4d, 0x3b, 0xfe, 0x38, 0x9a, 0x27, 0x5a}
	if got := sha256.Sum256(ce.data); got != want {
		t.Fatalf("cache hash=%x want=%x", got, want)
	}

	c2s := make([]byte, 14)
	binary.LittleEndian.PutUint16(c2s[0:], 42)
	binary.LittleEndian.PutUint16(c2s[2:], 6)
	binary.LittleEndian.PutUint16(c2s[4:], 2)
	binary.LittleEndian.PutUint16(c2s[6:], 2)
	binary.LittleEndian.PutUint16(c2s[8:], 3)
	binary.LittleEndian.PutUint16(c2s[10:], 30)
	binary.LittleEndian.PutUint16(c2s[12:], 25)
	g.onCacheToSurface(c2s)

	for _, p := range [][2]int{{2, 3}, {30, 25}} {
		region := make([]byte, 78*17*4)
		for row := 0; row < 17; row++ {
			src := ((p[1]+row)*120 + p[0]) * 4
			copy(region[row*78*4:(row+1)*78*4], g.surfaces[6].data[src:src+78*4])
		}
		if got := sha256.Sum256(region); got != want {
			t.Fatalf("dest %v hash=%x want=%x", p, got, want)
		}
	}
}
