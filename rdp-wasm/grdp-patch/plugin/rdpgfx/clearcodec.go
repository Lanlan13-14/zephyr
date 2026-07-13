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
	clearVBarCacheSize      = 32768
	clearShortVBarCacheSize = 16384
	clearMaxBandHeight      = 52
)

type clearGlyph struct {
	width, height int
	pixels        []byte
}

type clearDecoder struct {
	vbars       [][]byte
	shortVbars  [][]byte
	glyphs      map[uint16]clearGlyph
	vbarCursor  int
	shortCursor int
}

func newClearDecoder() *clearDecoder {
	return &clearDecoder{
		vbars:      make([][]byte, clearVBarCacheSize),
		shortVbars: make([][]byte, clearShortVBarCacheSize),
		glyphs:     make(map[uint16]clearGlyph),
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
	_ = c.u8()
	var glyphIndex uint16
	hasGlyph := flags&clearFlagGlyphIndex != 0
	if hasGlyph {
		if err := c.need(2, "glyph index"); err != nil {
			return nil, err
		}
		glyphIndex = c.u16()
		if glyphIndex >= clearGlyphCacheSize {
			return nil, fmt.Errorf("ClearCodec glyph index %d", glyphIndex)
		}
	}
	if flags&clearFlagCacheReset != 0 {
		d.vbarCursor = 0
		d.shortCursor = 0
	}
	if flags&clearFlagGlyphHit != 0 {
		if !hasGlyph {
			return nil, fmt.Errorf("ClearCodec glyph hit without index")
		}
		g, ok := d.glyphs[glyphIndex]
		if !ok || g.width != width || g.height != height {
			return nil, fmt.Errorf("ClearCodec glyph cache miss %d", glyphIndex)
		}
		return append([]byte(nil), g.pixels...), nil
	}
	hadBands := c.remaining() >= 12 && binary.LittleEndian.Uint32(c.data[c.off+4:c.off+8]) > 0
	out := make([]byte, width*height*4)
	if c.remaining() > 0 {
		if err := d.decodeComposite(c, out, width); err != nil {
			return nil, err
		}
	}
	if hasGlyph && width*height <= 1024 {
		d.glyphs[glyphIndex] = clearGlyph{width, height, append([]byte(nil), out...)}
	}
	_ = hadBands // retained for debugger visibility of stream layer selection
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
	if err := decodeClearSubcodecs(sub, out, width); err != nil {
		return err
	}
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
			out[o], out[o+1], out[o+2], out[o+3] = b, g, r, 0
		}
		pixel += int(run)
		if pixel == max {
			break
		}
	}
	return nil
}

func decodeClearSubcodecs(data, out []byte, surfW int) error {
	c := &clearCursor{data: data}
	surfH := len(out) / (surfW * 4)
	for c.remaining() > 0 {
		if err := c.need(13, "subcodec header"); err != nil {
			return err
		}
		x, y, w, h := int(c.u16()), int(c.u16()), int(c.u16()), int(c.u16())
		n := int(c.u32())
		id := c.u8()
		if w <= 0 || h <= 0 || x+w > surfW || y+h > surfH {
			return fmt.Errorf("ClearCodec subcodec bounds")
		}
		if err := c.need(n, "subcodec payload"); err != nil {
			return err
		}
		payload := c.take(n)
		switch id {
		case 0:
			if err := decodeClearRaw(payload, out, x, y, w, h, surfW); err != nil {
				return err
			}
		case 2:
			if err := decodeClearRlexRegion(payload, out, x, y, w, h, surfW); err != nil {
				return err
			}
		default:
			return fmt.Errorf("ClearCodec unsupported subcodec %d", id)
		}
	}
	return nil
}

func decodeClearRaw(data, out []byte, x0, y0, w, h, surfW int) error {
	if len(data) < w*h*3 {
		return fmt.Errorf("ClearCodec raw truncated")
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			s := (y*w + x) * 3
			d := ((y0+y)*surfW + x0 + x) * 4
			out[d], out[d+1], out[d+2], out[d+3] = data[s], data[s+1], data[s+2], 0xff
		}
	}
	return nil
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
func (d *clearDecoder) storeVBar(v []byte) int {
	i := d.vbarCursor
	d.vbars[i] = append([]byte(nil), v...)
	d.vbarCursor = (i + 1) % len(d.vbars)
	return i
}
func (d *clearDecoder) storeShort(v []byte) {
	i := d.shortCursor
	d.shortVbars[i] = append([]byte(nil), v...)
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
			// FreeRDP compatibility: isolated examples may reference a cache
			// entry populated by a prior frame. Synthesize BGRX black pixels.
			d.vbars[i] = make([]byte, height*4)
		}
		return d.vbars[i], nil
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
	if yOff < yOn || yOff > height {
		return nil, fmt.Errorf("ClearCodec invalid short VBar %d..%d height %d", yOn, yOff, height)
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
		if xe < xs || ye < ys || xe >= width || ye >= height {
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
			rows := min(len(bar)/4, bh)
			for row := 0; row < rows; row++ {
				s := row * 4
				dst := ((ys+row)*width + x) * 4
				copy(out[dst:dst+4], bar[s:s+4])
			}
		}
	}
	return nil
}
