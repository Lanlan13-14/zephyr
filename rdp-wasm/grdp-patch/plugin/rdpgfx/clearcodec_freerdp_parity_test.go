package rdpgfx

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// Build a ClearCodec stream: flags, seq, [glyphIndex], then layer counts and
// layer payloads. Mirrors FreeRDP clear_decompress input layout.
func buildClearStream(flags byte, seq byte, glyphIndex *uint16, residual, bands, sub []byte) []byte {
	var b []byte
	b = append(b, flags, seq)
	if glyphIndex != nil {
		var g [2]byte
		binary.LittleEndian.PutUint16(g[:], *glyphIndex)
		b = append(b, g[:]...)
	}
	var cnt [12]byte
	binary.LittleEndian.PutUint32(cnt[0:4], uint32(len(residual)))
	binary.LittleEndian.PutUint32(cnt[4:8], uint32(len(bands)))
	binary.LittleEndian.PutUint32(cnt[8:12], uint32(len(sub)))
	b = append(b, cnt[:]...)
	b = append(b, residual...)
	b = append(b, bands...)
	b = append(b, sub...)
	return b
}

// residualSolid encodes a residual layer filling count pixels with (b,g,r).
// Literal runs cap at 254: 0xFF introduces the extended u16/u32 length form.
func residualSolid(b, g, r byte, count int) []byte {
	var out []byte
	for count > 0 {
		n := count
		if n > 254 {
			n = 254
		}
		out = append(out, b, g, r, byte(n))
		count -= n
	}
	return out
}

func glyphIndexPtr(v uint16) *uint16 { return &v }

func TestClearGlyphStoreAndHitAbove1024Pixels(t *testing.T) {
	d := newClearDecoder()
	// 64x64 glyph = 4096 pixels: above the old 1024-px cap but well within
	// FreeRDP's 1024*1024 limit. Old code refused to store it and every later
	// hit failed -> tile dropped (the real-session mosaic mechanism).
	store := buildClearStream(clearFlagGlyphIndex, 1, glyphIndexPtr(5), residualSolid(10, 20, 30, 64*64), nil, nil)
	if _, err := d.decode(store, 64, 64); err != nil {
		t.Fatalf("store: %v", err)
	}
	if _, ok := d.glyphs[5]; !ok {
		t.Fatal("glyph not stored above 1024 pixels")
	}
	hit := buildClearStream(clearFlagGlyphIndex|clearFlagGlyphHit, 2, glyphIndexPtr(5), nil, nil, nil)
	out, err := d.decode(hit, 64, 64)
	if err != nil {
		t.Fatalf("hit: %v", err)
	}
	if out[0] != 10 || out[1] != 20 || out[2] != 30 {
		t.Fatalf("hit pixels = %v", out[:3])
	}
}

func TestClearGlyphHitFlatPrefixSemantics(t *testing.T) {
	d := newClearDecoder()
	// Store a 64x64 glyph, then hit it with 32x32: FreeRDP reads a flat
	// prefix (count = w*h pixels, source stride = current width), it does not
	// require matching dimensions.
	res := make([]byte, 0, 64*64*4/254*4)
	for i := 0; i < 64*64; i += 254 {
		n := 64*64 - i
		if n > 254 {
			n = 254
		}
		// unique-ish pattern per run so prefix content is distinguishable
		res = append(res, byte(i%251), byte(i%253), byte(i%255), byte(n))
	}
	store := buildClearStream(clearFlagGlyphIndex, 1, glyphIndexPtr(7), res, nil, nil)
	stored, err := d.decode(store, 64, 64)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	hit := buildClearStream(clearFlagGlyphIndex|clearFlagGlyphHit, 2, glyphIndexPtr(7), nil, nil, nil)
	out, err := d.decode(hit, 32, 32)
	if err != nil {
		t.Fatalf("prefix hit must succeed, got %v", err)
	}
	for i := range 32 * 32 * 4 {
		if out[i] != stored[i] {
			t.Fatalf("prefix byte %d = %d want %d", i, out[i], stored[i])
		}
	}
}

func TestClearGlyphHitThenLayers(t *testing.T) {
	d := newClearDecoder()
	store := buildClearStream(clearFlagGlyphIndex, 1, glyphIndexPtr(9), residualSolid(1, 2, 3, 16), nil, nil)
	if _, err := d.decode(store, 4, 4); err != nil {
		t.Fatalf("store: %v", err)
	}
	// Hit followed by a residual layer: FreeRDP copies the glyph and then
	// applies the composite layers on top.
	hit := buildClearStream(clearFlagGlyphIndex|clearFlagGlyphHit, 2, glyphIndexPtr(9), residualSolid(9, 8, 7, 16), nil, nil)
	out, err := d.decode(hit, 4, 4)
	if err != nil {
		t.Fatalf("hit+layers: %v", err)
	}
	if out[0] != 9 || out[1] != 8 || out[2] != 7 {
		t.Fatalf("layers did not apply on top of glyph hit: %v", out[:3])
	}
}

func TestClearGlyphStoreWithoutPayloadIsError(t *testing.T) {
	d := newClearDecoder()
	b := []byte{clearFlagGlyphIndex, 1, 7, 0}
	if _, err := d.decode(b, 4, 4); err == nil {
		t.Fatal("glyph store without payload must fail (FreeRDP parity)")
	}
}

func TestClearShortVBarYOffBeyondBandHeightTolerated(t *testing.T) {
	d := newClearDecoder()
	// Band 2 wide x 10 high; short VBar miss yOn=2 yOff=15 (> band height).
	// FreeRDP accepts (only yOff-yOn<=52 matters); the old code failed the
	// whole tile.
	var band []byte
	var hdr [11]byte
	binary.LittleEndian.PutUint16(hdr[0:2], 0) // xs
	binary.LittleEndian.PutUint16(hdr[2:4], 1) // xe
	binary.LittleEndian.PutUint16(hdr[4:6], 0) // ys
	binary.LittleEndian.PutUint16(hdr[6:8], 9) // ye -> bh=10
	hdr[8], hdr[9], hdr[10] = 100, 110, 120    // bg
	band = append(band, hdr[:]...)
	for col := 0; col < 2; col++ {
		var vh [2]byte
		binary.LittleEndian.PutUint16(vh[:], uint16(2|(15<<8))) // yOn=2, yOff=15
		band = append(band, vh[:]...)
		for i := 0; i < 13; i++ { // 15-2=13 short pixels
			band = append(band, byte(i), byte(i+1), byte(i+2))
		}
	}
	stream := buildClearStream(0, 1, nil, nil, band, nil)
	out, err := d.decode(stream, 2, 10)
	if err != nil {
		t.Fatalf("yOff beyond band height must be tolerated: %v", err)
	}
	// Column 0 row 0: background.
	if out[0] != 100 || out[1] != 110 || out[2] != 120 {
		t.Fatalf("bg row = %v", out[:3])
	}
	// Column 0 row 2: first short pixel (0,1,2).
	o := (2*2 + 0) * 4
	if out[o] != 0 || out[o+1] != 1 || out[o+2] != 2 {
		t.Fatalf("short pixel = %v", out[o:o+3])
	}
}

func TestClearBandBeyondTileBoundsSkipsColumns(t *testing.T) {
	d := newClearDecoder()
	// Tile 4x10, band spans xs=2..xe=9 (xe beyond tile width): bytes for all
	// 8 columns are consumed, only x=2,3 written. Old code failed the tile.
	var band []byte
	var hdr [11]byte
	binary.LittleEndian.PutUint16(hdr[0:2], 2)
	binary.LittleEndian.PutUint16(hdr[2:4], 9)
	binary.LittleEndian.PutUint16(hdr[4:6], 0)
	binary.LittleEndian.PutUint16(hdr[6:8], 9)
	hdr[8], hdr[9], hdr[10] = 7, 8, 9
	band = append(band, hdr[:]...)
	for col := 0; col < 8; col++ {
		var vh [2]byte
		binary.LittleEndian.PutUint16(vh[:], uint16(0|(1<<8))) // yOn=0, yOff=1
		band = append(band, vh[:]...)
		band = append(band, 50, 60, 70) // 1 short pixel
	}
	stream := buildClearStream(0, 1, nil, nil, band, nil)
	out, err := d.decode(stream, 4, 10)
	if err != nil {
		t.Fatalf("band beyond tile bounds must be tolerated: %v", err)
	}
	// x=2 row 0: short pixel written.
	o := (0*4 + 2) * 4
	if out[o] != 50 || out[o+1] != 60 || out[o+2] != 70 {
		t.Fatalf("in-bounds column not written: %v", out[o:o+3])
	}
	// x=0 row 0: untouched (zero).
	if out[0] != 0 || out[1] != 0 || out[2] != 0 {
		t.Fatalf("out-of-band column touched: %v", out[:3])
	}
}

func TestClearUnknownSubcodecKeepsTile(t *testing.T) {
	d := newClearDecoder()
	// Unknown subcodec id 9 with 6 payload bytes: skipped, residual survives.
	sub := []byte{0, 0, 0, 0, 2, 0, 2, 0, 6, 0, 0, 0, 9, 1, 2, 3, 4, 5, 6}
	stream := buildClearStream(0, 1, nil, residualSolid(11, 22, 33, 4*4), nil, sub)
	out, err := d.decode(stream, 4, 4)
	if err != nil {
		t.Fatalf("unknown subcodec must not drop the tile: %v", err)
	}
	if out[0] != 11 || out[1] != 22 || out[2] != 33 {
		t.Fatalf("residual lost: %v", out[:3])
	}
	found := false
	for _, w := range d.takeWarns() {
		if strings.Contains(w, "unsupported subcodec 9") {
			found = true
		}
	}
	if !found {
		t.Fatal("missing skip warning")
	}
}

func buildNSCodecRaw2x2() []byte {
	msg := make([]byte, 20)
	binary.LittleEndian.PutUint32(msg[0:], 4)
	binary.LittleEndian.PutUint32(msg[4:], 4)
	binary.LittleEndian.PutUint32(msg[8:], 4)
	binary.LittleEndian.PutUint32(msg[12:], 0)
	msg[16] = 1                   // ColorLossLevel must be in FreeRDP's accepted [1,7] range.
	msg = append(msg, 0, 1, 2, 3) // Y
	msg = append(msg, 0, 0, 0, 0) // Co
	msg = append(msg, 0, 0, 0, 0) // Cg
	return msg
}

func TestClearNSCodecSubcodecDecodedTopDown(t *testing.T) {
	nsc := buildNSCodecRaw2x2()
	sub := make([]byte, 13+len(nsc))
	binary.LittleEndian.PutUint16(sub[4:], 2)
	binary.LittleEndian.PutUint16(sub[6:], 2)
	binary.LittleEndian.PutUint32(sub[8:], uint32(len(nsc)))
	sub[12] = 1
	copy(sub[13:], nsc)
	stream := buildClearStream(0, 1, nil, residualSolid(11, 22, 33, 2*2), nil, sub)

	out, err := newClearDecoder().decode(stream, 2, 2)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	want := []byte{
		0, 0, 0, 0xFF, 1, 1, 1, 0xFF,
		2, 2, 2, 0xFF, 3, 3, 3, 0xFF,
	}
	if !bytes.Equal(out, want) {
		t.Fatalf("decoded NSCodec pixels=%v want=%v", out, want)
	}
}

func TestClearNSCodecMalformedPayloadDropsWholeTile(t *testing.T) {
	d := newClearDecoder()
	sub := []byte{0, 0, 0, 0, 2, 0, 2, 0, 6, 0, 0, 0, 1, 1, 2, 3, 4, 5, 6}
	stream := buildClearStream(0, 1, nil, residualSolid(11, 22, 33, 4*4), nil, sub)
	if _, err := d.decode(stream, 4, 4); err == nil || !strings.Contains(strings.ToLower(err.Error()), "nscodec") {
		t.Fatalf("malformed NSCodec must reject the complete ClearCodec tile, got %v", err)
	}
}

func TestClearSeqMismatchWipesCaches(t *testing.T) {
	d := newClearDecoder()
	store := buildClearStream(clearFlagGlyphIndex, 1, glyphIndexPtr(3), residualSolid(4, 5, 6, 16), nil, nil)
	if _, err := d.decode(store, 4, 4); err != nil {
		t.Fatalf("store: %v", err)
	}
	// seq jumps 2 -> 9: caches must be wiped, hit must now miss.
	bad := buildClearStream(clearFlagGlyphIndex|clearFlagGlyphHit, 9, glyphIndexPtr(3), nil, nil, nil)
	if _, err := d.decode(bad, 4, 4); err == nil || !strings.Contains(err.Error(), "cache miss") {
		t.Fatalf("expected cache miss after seq gap, got %v", err)
	}
	if d.seqMismatch != 1 {
		t.Fatalf("seqMismatch=%d", d.seqMismatch)
	}
	// And the decoder resynced: next sequential stream decodes fine.
	d2 := d.seq
	if d2 != 10 {
		t.Fatalf("seq resynced to %d, want 10", d2)
	}
}

func TestClearSeqAdoptsFirstNonZero(t *testing.T) {
	d := newClearDecoder()
	// First stream carries seq 42: adopted (FreeRDP: !seqNumber && seqNumber).
	s := buildClearStream(0, 42, nil, residualSolid(1, 2, 3, 4), nil, nil)
	if _, err := d.decode(s, 2, 2); err != nil {
		t.Fatalf("first seq adopt: %v", err)
	}
	s2 := buildClearStream(0, 43, nil, residualSolid(1, 2, 3, 4), nil, nil)
	if _, err := d.decode(s2, 2, 2); err != nil {
		t.Fatalf("sequential stream: %v", err)
	}
	if d.seqMismatch != 0 {
		t.Fatalf("unexpected mismatch count %d", d.seqMismatch)
	}
}

func TestResetGraphicsPreservesClearCodecCaches(t *testing.T) {
	g := NewGfxHandler(nil)
	defer g.Close()

	store := buildClearStream(clearFlagGlyphIndex, 1, glyphIndexPtr(17), residualSolid(7, 8, 9, 4), nil, nil)
	if _, err := g.clearDecoder.decode(store, 2, 2); err != nil {
		t.Fatalf("store before reset: %v", err)
	}

	reset := make([]byte, 12)
	binary.LittleEndian.PutUint32(reset[0:4], 1920)
	binary.LittleEndian.PutUint32(reset[4:8], 1080)
	g.onResetGraphics(reset)

	hit := buildClearStream(clearFlagGlyphIndex|clearFlagGlyphHit, 42, glyphIndexPtr(17), nil, nil, nil)
	out, err := g.clearDecoder.decode(hit, 2, 2)
	if err != nil {
		t.Fatalf("cache hit after ResetGraphics: %v", err)
	}
	if len(out) != 2*2*4 || out[0] != 7 || out[1] != 8 || out[2] != 9 {
		t.Fatalf("cached pixels were not preserved: %v", out)
	}
}

// Regression: a zero-length short VBar (yOff==yOn, a column of pure
// background) must be stored as a real cache entry. The old append-to-nil
// stored a nil slice, so every later SHORT_HIT on that slot failed with
// "short VBar miss" and the whole tile was dropped — the real-session
// mosaic cascade. (Root cause confirmed against FreeRDP clear.c, which
// keeps the entry with count=0 and accepts the hit.)
func TestClearZeroLengthShortVBarHit(t *testing.T) {
	d := newClearDecoder()
	// One-column band 1x10: short miss yOn=0, yOff=0 (zero short pixels).
	var band []byte
	var hdr [11]byte
	binary.LittleEndian.PutUint16(hdr[0:2], 0) // xs
	binary.LittleEndian.PutUint16(hdr[2:4], 0) // xe
	binary.LittleEndian.PutUint16(hdr[4:6], 0) // ys
	binary.LittleEndian.PutUint16(hdr[6:8], 9) // ye -> bh=10
	hdr[8], hdr[9], hdr[10] = 9, 8, 7
	band = append(band, hdr[:]...)
	var vh [2]byte
	binary.LittleEndian.PutUint16(vh[:], 0) // yOn=0, yOff=0 -> zero-length short
	band = append(band, vh[:]...)
	stream := buildClearStream(0, 1, nil, nil, band, nil)
	if _, err := d.decode(stream, 1, 10); err != nil {
		t.Fatalf("zero-length short store: %v", err)
	}
	// Second stream: SHORT_HIT on index 0 — must succeed (empty => all bg).
	var band2 []byte
	hdr2 := hdr
	hdr2[8], hdr2[9], hdr2[10] = 9, 8, 7
	band2 = append(band2, hdr2[:]...)
	var vh2 [2]byte
	binary.LittleEndian.PutUint16(vh2[:], 0x4000) // SHORT_HIT idx=0
	band2 = append(band2, vh2[:]...)
	band2 = append(band2, 0) // yOn=0
	stream2 := buildClearStream(0, 2, nil, nil, band2, nil)
	out, err := d.decode(stream2, 1, 10)
	if err != nil {
		t.Fatalf("zero-length short hit must succeed: %v", err)
	}
	for i := 0; i < 10; i++ {
		o := i * 4
		if out[o] != 9 || out[o+1] != 8 || out[o+2] != 7 {
			t.Fatalf("row %d = %v, want bg", i, out[o:o+3])
		}
	}
}
