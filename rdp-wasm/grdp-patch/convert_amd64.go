//go:build amd64

package grdp

import "encoding/binary"

// bgr32BatchToRGBA converts n BGRA32 pixels (4 bytes each: B,G,R,X in memory) to
// RGBA using SSE2.  Processes 8 pixels per iteration; remainder is scalar.
func bgr32BatchToRGBA(dst []byte, src []byte, n int) {
	n8 := n &^ 7
	if n8 > 0 {
		bgr32toRGBAasm(&dst[0], &src[0], n8)
	}
	for i := n8; i < n; i++ {
		s := i * 4
		binary.LittleEndian.PutUint32(dst[s:],
			uint32(src[s+2])|uint32(src[s+1])<<8|uint32(src[s])<<16|0xFF000000)
	}
}

//go:noescape
func bgr32toRGBAasm(dst *byte, src *byte, n int)

// rgb555BatchToRGBA converts n big-endian RGB555 pixels to RGBA using SSE2.
// Processes 8 pixels per iteration; any remainder is handled via scalar fallback.
func rgb555BatchToRGBA(dst []byte, src []byte, n int) {
	n8 := n &^ 7
	if n8 > 0 {
		rgb555toRGBAasm(&dst[0], &src[0], n8)
	}
	for i := n8; i < n; i++ {
		d := binary.BigEndian.Uint16(src[i*2:])
		binary.LittleEndian.PutUint32(dst[i*4:],
			uint32((d&0x7C00)>>7)|uint32((d&0x03E0)>>2)<<8|uint32((d&0x001F)<<3)<<16|0xFF000000)
	}
}

// rgb565BatchToRGBA converts n big-endian RGB565 pixels to RGBA using SSE2.
func rgb565BatchToRGBA(dst []byte, src []byte, n int) {
	n8 := n &^ 7
	if n8 > 0 {
		rgb565toRGBAasm(&dst[0], &src[0], n8)
	}
	for i := n8; i < n; i++ {
		d := binary.BigEndian.Uint16(src[i*2:])
		binary.LittleEndian.PutUint32(dst[i*4:],
			uint32((d&0xF800)>>8)|uint32((d&0x07E0)>>3)<<8|uint32((d&0x001F)<<3)<<16|0xFF000000)
	}
}

//go:noescape
func rgb555toRGBAasm(dst *byte, src *byte, n int)

//go:noescape
func rgb565toRGBAasm(dst *byte, src *byte, n int)
