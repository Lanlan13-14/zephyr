package rdpgfx

import (
	"encoding/binary"
	"fmt"
)

const (
	clearFlagGlyphIndex     = 0x01
	clearFlagGlyphHit       = 0x02
	clearFlagCacheReset     = 0x04
	clearGlyphCacheSize     = 4000
	clearGlyphMaxPixels     = 1024 * 1024 // FreeRDP clear.c: glyph too large above 1024*1024
	clearVBarCacheSize      = 32768
	clearShortVBarCacheSize = 16384
	clearMaxBandHeight      = 52
)

// clearGlyph is a cached ClearCodec glyph. Pixels are a flat row-major BGRX
// array; a GLYPH_HIT reads the first w*h pixels (FreeRDP semantics: the hit
// copy uses the current PDU's nWidth as source stride, i.e. a flat prefix).
type clearGlyph struct {
	width, height int
	pixels        []byte
}

// clearDecoder holds the per-channel ClearCodec codec caches. All fields are
// keyed exactly like FreeRDP's CLEAR_CONTEXT (VBarStorage / ShortVBarStorage
// / GlyphCache) so behavior can be compared against clear.c line by line.
type clearDecoder struct {
	vbars       [][]byte
	shortVbars  [][]byte
	glyphs      map[uint16]clearGlyph
	vbarCursor  int
	shortCursor int
	seq         byte
	seqMismatch uint32
	warns       []string
}

func newClearDecoder() *clearDecoder {
	return &clearDecoder{
		vbars:      make([][]byte, clearVBarCacheSize),
		shortVbars: make([][]byte, clearShortVBarCacheSize),
		glyphs:     make(map[uint16]clearGlyph),
	}
}

// takeWarns returns and clears the decode warnings accumulated since the last
// call. The WTS1 handler forwards them to the protocol observer so dropped or
// degraded tiles are visible in telemetry instead of silent.
func (d *clearDecoder) takeWarns() []string {
	w := d.warns
	d.warns = nil
	return w
}

func (d *clearDecoder) warnf(format string, args ...any) {
	if len(d.warns) < 16 {
		d.warns = append(d.warns, fmt.Sprintf(format, args...))
	}
}

type clearCursor struct {
	data []byte
	off  int
}

func (c *clearCursor) remaining() int { return len(c.data) - c.off }
func (c *clearCursor) need(n int, what string) error {
	if n < 0 || c.remaining() < n {
		return fmt.Errorf("ClearCodec %s truncated: need %d have %d", what, n, c.remaining())
	}
	return nil
}
func (c *clearCursor) u8() byte { v := c.data[c.off]; c.off++; return v }
func (c *clearCursor) u16() uint16 {
	v := binary.LittleEndian.Uint16(c.data[c.off:])
	c.off += 2
	return v
}
func (c *clearCursor) u32() uint32 {
	v := binary.LittleEndian.Uint32(c.data[c.off:])
	c.off += 4
	return v
}
func (c *clearCursor) take(n int) []byte { v := c.data[c.off : c.off+n]; c.off += n; return v }

// clearRunLength reads the variable-length run factor (1, 1+2 or 1+2+4 bytes),
// identical to FreeRDP's runLengthFactor handling.
func clearRunLength(c *clearCursor, what string) (uint32, error) {
	if err := c.need(1, what); err != nil {
		return 0, err
	}
	a := c.u8()
	if a < 0xff {
		return uint32(a), nil
	}
	if err := c.need(2, what); err != nil {
		return 0, err
	}
	b := c.u16()
	if b < 0xffff {
		return uint32(b), nil
	}
	if err := c.need(4, what); err != nil {
		return 0, err
	}
	return c.u32(), nil
}

func (d *clearDecoder) decode(data []byte, width, height int) ([]byte, error) {
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("ClearCodec invalid dimensions %dx%d", width, height)
	}
	c := &clearCursor{data: data}
	if err := c.need(2, "stream header"); err != nil {
		return nil, err
	}
	flags := c.u8()
	seq := c.u8()

	// Sequence continuity guards every codec cache. FreeRDP hard-fails on a
	// mismatch (clear.c: seqNumber != clear->seqNumber); we self-heal instead:
	// a missed stream invalidates all caches, so wipe them and resync to the
	// sender. Continuing with desynced caches paints stale VBars/glyphs.
	if d.seq == 0 && seq != 0 {
		d.seq = seq
	}
	if seq != d.seq {
		d.seqMismatch++
		d.warnf("seq mismatch got %d want %d: caches wiped", seq, d.seq)
		d.vbarCursor = 0
		d.shortCursor = 0
		d.vbars = make([][]byte, clearVBarCacheSize)
		d.shortVbars = make([][]byte, clearShortVBarCacheSize)
		d.glyphs = make(map[uint16]clearGlyph)
		d.seq = seq
	}
	d.seq = (seq + 1) & 0xff

	var glyphIndex uint16
	hasGlyph := flags&clearFlagGlyphIndex != 0
	if hasGlyph {
		if width*height > clearGlyphMaxPixels {
			return nil, fmt.Errorf("ClearCodec glyph too large: %dx%d", width, height)
		}
		if err := c.need(2, "glyph index"); err != nil {
			return nil, err
		}
		glyphIndex = c.u16()
		if glyphIndex >= clearGlyphCacheSize {
			return nil, fmt.Errorf("ClearCodec glyph index %d", glyphIndex)
		}
	}
	if flags&clearFlagCacheReset != 0 {
		// FreeRDP clear_reset_vbar_storage(clear, FALSE): cursors reset,
		// storage content kept.
		d.vbarCursor = 0
		d.shortCursor = 0
	}

	out := make([]byte, width*height*4)

	if flags&clearFlagGlyphHit != 0 {
		if !hasGlyph {
			return nil, fmt.Errorf("ClearCodec glyph hit without index")
		}
		g, ok := d.glyphs[glyphIndex]
		if !ok {
			return nil, fmt.Errorf("ClearCodec glyph cache miss %d", glyphIndex)
		}
		// FreeRDP: (nWidth*nHeight) > glyphEntry->count -> error; otherwise a
		// flat prefix copy of count pixels (source stride = nWidth).
		if width*height > len(g.pixels)/4 {
			return nil, fmt.Errorf("ClearCodec glyph %d too small: need %d have %d", glyphIndex, width*height, len(g.pixels)/4)
		}
		copy(out, g.pixels[:width*height*4])
	}

	// After glyph handling a stream may end (pure glyph store/hit) or carry a
	// composite payload. FreeRDP: remaining < 12 is only valid when both
	// GLYPH_INDEX and GLYPH_HIT are set (pure hit); anything else is an error.
	if c.remaining() < 12 {
		if hasGlyph && flags&clearFlagGlyphHit != 0 {
			return out, nil
		}
		if hasGlyph && c.remaining() == 0 {
			return nil, fmt.Errorf("ClearCodec glyph store without payload")
		}
		return nil, fmt.Errorf("ClearCodec missing composite header: %d bytes", c.remaining())
	}
	if err := d.decodeComposite(c, out, width); err != nil {
		return nil, err
	}

	if hasGlyph {
		// Store the fully decoded output (layers applied), FreeRDP copies the
		// dst area into the glyph entry at the end of clear_decompress.
		d.glyphs[glyphIndex] = clearGlyph{width, height, append([]byte(nil), out...)}
	}
	return out, nil
}

func (d *clearDecoder) decodeComposite(c *clearCursor, out []byte, width int) error {
	if err := c.need(12, "composite header"); err != nil {
		return err
	}
	nr, nb, ns := int(c.u32()), int(c.u32()), int(c.u32())
	total := nr + nb + ns
	if total < 0 {
		return fmt.Errorf("ClearCodec layer size overflow")
	}
	if err := c.need(total, "composite layers"); err != nil {
		return err
	}
	residual, bands, sub := c.take(nr), c.take(nb), c.take(ns)
	if err := decodeClearResidual(residual, out); err != nil {
		return err
	}
	if err := d.decodeClearBands(bands, out, width); err != nil {
		return err
	}
	// The subcodec layer never fails the tile: residual+bands content is
	// usually the smooth background and is far better than dropping the whole
	// update. Offending subcodecs are skipped and counted (FreeRDP would fail
	// the whole decompress; for a UI client that is the difference between a
	// stale mosaic and a nearly-correct frame).
	d.decodeClearSubcodecs(sub, out, width)
	if c.remaining() != 0 {
		return fmt.Errorf("ClearCodec trailing bytes %d", c.remaining())
	}
	return nil
}

func decodeClearResidual(data, out []byte) error {
	c := &clearCursor{data: data}
	pixel := 0
	max := len(out) / 4
	for c.remaining() > 0 {
		if err := c.need(4, "residual run"); err != nil {
			return err
		}
		b, g, r := c.u8(), c.u8(), c.u8()
		run, err := clearRunLength(c, "residual run length")
		if err != nil {
			return err
		}
		if uint64(run) > uint64(max-pixel) {
			run = uint32(max - pixel)
		}
		for i := 0; i < int(run); i++ {
			o := (pixel + i) * 4
			out[o], out[o+1], out[o+2], out[o+3] = b, g, r, 0xFF
		}
		pixel += int(run)
		if pixel == max {
			break
		}
	}
	return nil
}

// decodeClearSubcodecs decodes what it can and skips what it cannot. Every
// skip is recorded as a warning; the tile itself is kept.
func (d *clearDecoder) decodeClearSubcodecs(data, out []byte, surfW int) {
	c := &clearCursor{data: data}
	surfH := len(out) / (surfW * 4)
	for c.remaining() > 0 {
		if c.remaining() < 13 {
			d.warnf("subcodec header truncated: %d bytes", c.remaining())
			return
		}
		x, y, w, h := int(c.u16()), int(c.u16()), int(c.u16()), int(c.u16())
		n := int(c.u32())
		id := c.u8()
		if c.remaining() < n {
			d.warnf("subcodec %d payload truncated: need %d have %d", id, n, c.remaining())
			return
		}
		payload := c.take(n)
		if w <= 0 || h <= 0 || x+w > surfW || y+h > surfH {
			d.warnf("subcodec %d bounds (%d,%d %dx%d)", id, x, y, w, h)
			continue
		}
		switch id {
		case 0:
			if len(payload) != w*h*3 {
				d.warnf("raw subcodec size %d != %d", len(payload), w*h*3)
				continue
			}
			decodeClearRaw(payload, out, x, y, w, h, surfW)
		case 1:
			// NSCODEC: not implemented; counted so telemetry shows its
			// frequency. FreeRDP decodes it via nsc_process_message.
			d.warnf("nscodec subcodec %dx%d skipped", w, h)
		case 2:
			if err := decodeClearRlexRegion(payload, out, x, y, w, h, surfW); err != nil {
				d.warnf("rlex: %v", err)
			}
		default:
			d.warnf("unsupported subcodec %d", id)
		}
	}
}

func decodeClearRaw(data, out []byte, x0, y0, w, h, surfW int) {
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			s := (y*w + x) * 3
			d := ((y0+y)*surfW + x0 + x) * 4
			out[d], out[d+1], out[d+2], out[d+3] = data[s], data[s+1], data[s+2], 0xff
		}
	}
}

func decodeClearRlexRegion(data, out []byte, x0, y0, w, h, surfW int) error {
	c := &clearCursor{data: data}
	if err := c.need(1, "RLEX palette count"); err != nil {
		return err
	}
	pc := int(c.u8())
	if pc < 1 || pc > 127 {
		return fmt.Errorf("ClearCodec RLEX palette count %d", pc)
	}
	if err := c.need(pc*3, "RLEX palette"); err != nil {
		return err
	}
	pal := make([][3]byte, pc)
	for i := range pc {
		pal[i] = [3]byte{c.u8(), c.u8(), c.u8()}
	}
	bits := 1
	for (1 << bits) < pc {
		bits++
	}
	stopMask := byte((1 << bits) - 1)
	depthBits := 8 - bits
	depthMask := byte((1 << depthBits) - 1)
	px := 0
	limit := w * h
	put := func(color [3]byte) {
		xx := px % w
		yy := px / w
		d := ((y0+yy)*surfW + x0 + xx) * 4
		out[d], out[d+1], out[d+2], out[d+3] = color[0], color[1], color[2], 0xff
		px++
	}
	for c.remaining() > 0 && px < limit {
		packed := c.u8()
		stop := int(packed & stopMask)
		depth := int((packed >> bits) & depthMask)
		start := stop - depth
		if start < 0 || stop >= pc {
			return fmt.Errorf("ClearCodec RLEX index")
		}
		run, err := clearRunLength(c, "RLEX run")
		if err != nil {
			return err
		}
		for i := uint32(0); i < run && px < limit; i++ {
			put(pal[start])
		}
		for i := start; i <= stop && px < limit; i++ {
			put(pal[i])
		}
	}
	return nil
}

// clearFullVBar synthesizes a full-height VBar from a short entry, FreeRDP
// vBarUpdate semantics: rows [0,yOn) background, then the short pixels, then
// background again up to height.
func clearFullVBar(yOn int, short []byte, height int, bg [3]byte) []byte {
	out := make([]byte, height*4)
	for i := 0; i < height; i++ {
		o := i * 4
		out[o], out[o+1], out[o+2], out[o+3] = bg[0], bg[1], bg[2], 0xff
	}
	top := min(max(yOn, 0), height)
	rows := min(len(short)/3, height-top)
	for i := 0; i < rows; i++ {
		s, o := i*3, (top+i)*4
		out[o], out[o+1], out[o+2], out[o+3] = short[s], short[s+1], short[s+2], 0xff
	}
	return out
}
// storeVBar/storeShort copy into cache slots. make+copy (never append to
// nil): a zero-length short VBar (yOff==yOn, a column of pure background) is
// legal and common; append([]byte(nil)) would store a nil slice, making the
// slot indistinguishable from "never stored" and failing every later hit —
// which is exactly the real-session short-VBar-miss cascade. FreeRDP keeps
// the entry with count=0 and accepts the hit.
func (d *clearDecoder) storeVBar(v []byte) int {
	i := d.vbarCursor
	buf := make([]byte, len(v))
	copy(buf, v)
	d.vbars[i] = buf
	d.vbarCursor = (i + 1) % len(d.vbars)
	return i
}
func (d *clearDecoder) storeShort(v []byte) {
	i := d.shortCursor
	buf := make([]byte, len(v))
	copy(buf, v)
	d.shortVbars[i] = buf
	d.shortCursor = (i + 1) % len(d.shortVbars)
}
func (d *clearDecoder) decodeClearVBar(c *clearCursor, height int, bg [3]byte) ([]byte, error) {
	if err := c.need(2, "VBar header"); err != nil {
		return nil, err
	}
	header := c.u16()
	if header&0x8000 != 0 {
		i := int(header & 0x7fff)
		if i >= len(d.vbars) {
			return nil, fmt.Errorf("ClearCodec VBar index %d", i)
		}
		if d.vbars[i] == nil {
			// FreeRDP compatibility: empty cache entries are filled with
			// dummy (zeroed) pixels and resized to the band height.
			d.vbars[i] = make([]byte, height*4)
		}
		bar := d.vbars[i]
		// FreeRDP resize semantics: a cached VBar shorter than the band is
		// zero-extended to the band height (and the cache entry updated).
		if len(bar)/4 < height {
			nb := make([]byte, height*4)
			copy(nb, bar)
			d.vbars[i] = nb
			bar = nb
		}
		return bar, nil
	}
	if header&0x4000 != 0 {
		i := int(header & 0x3fff)
		if err := c.need(1, "short VBar hit yOn"); err != nil {
			return nil, err
		}
		yOn := int(c.u8())
		if i >= len(d.shortVbars) || d.shortVbars[i] == nil {
			return nil, fmt.Errorf("ClearCodec short VBar miss %d", i)
		}
		full := clearFullVBar(yOn, d.shortVbars[i], height, bg)
		d.storeVBar(full)
		return full, nil
	}
	yOn := int(header & 0xff)
	yOff := int((header >> 8) & 0x3f)
	if yOff < yOn {
		return nil, fmt.Errorf("ClearCodec invalid short VBar %d..%d", yOn, yOff)
	}
	if yOff-yOn > clearMaxBandHeight {
		return nil, fmt.Errorf("ClearCodec short VBar count %d", yOff-yOn)
	}
	n := (yOff - yOn) * 3
	if err := c.need(n, "short VBar pixels"); err != nil {
		return nil, err
	}
	short := append([]byte(nil), c.take(n)...)
	d.storeShort(short)
	full := clearFullVBar(yOn, short, height, bg)
	d.storeVBar(full)
	return full, nil
}

// decodeClearBands consumes one VBar per column in [xs, xe] (bytes are always
// consumed, FreeRDP reads the header for every column) and writes only the
// columns/rows that land inside the tile (FreeRDP skips out-of-tile writes
// instead of failing the whole stream).
func (d *clearDecoder) decodeClearBands(data, out []byte, width int) error {
	if len(data) == 0 {
		return nil
	}
	c := &clearCursor{data: data}
	height := len(out) / (width * 4)
	for c.remaining() > 0 {
		if err := c.need(11, "band header"); err != nil {
			return err
		}
		xs, xe, ys, ye := int(c.u16()), int(c.u16()), int(c.u16()), int(c.u16())
		bg := [3]byte{c.u8(), c.u8(), c.u8()}
		if xe < xs || ye < ys {
			return fmt.Errorf("ClearCodec invalid band bounds")
		}
		bh := ye - ys + 1
		if bh > clearMaxBandHeight {
			return fmt.Errorf("ClearCodec band height %d", bh)
		}
		for x := xs; x <= xe; x++ {
			bar, err := d.decodeClearVBar(c, bh, bg)
			if err != nil {
				return err
			}
			if x >= width {
				continue // bytes consumed, column outside the tile: skip write
			}
			rows := min(len(bar)/4, bh)
			for row := 0; row < rows; row++ {
				if ys+row >= height {
					break // row outside the tile: skip write
				}
				s := row * 4
				dst := ((ys+row)*width + x) * 4
				copy(out[dst:dst+4], bar[s:s+4])
			}
		}
	}
	return nil
}
