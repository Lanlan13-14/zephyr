//go:build !amd64 && !arm64

package grdp

import "encoding/binary"

// bgr32BatchToRGBA converts n BGRA32 pixels (4 bytes each: B,G,R,X) to RGBA.
func bgr32BatchToRGBA(dst []byte, src []byte, n int) {
	for i := range n {
		s := i * 4
		binary.LittleEndian.PutUint32(dst[s:],
			uint32(src[s+2])|uint32(src[s+1])<<8|uint32(src[s])<<16|0xFF000000)
	}
}

// rgb555BatchToRGBA converts n big-endian RGB555 pixels (src, 2 bytes each)
// to RGBA (dst, 4 bytes each). n must be valid for the slice sizes.
func rgb555BatchToRGBA(dst []byte, src []byte, n int) {
	for i := range n {
		d := binary.BigEndian.Uint16(src[i*2:])
		binary.LittleEndian.PutUint32(dst[i*4:],
			uint32((d&0x7C00)>>7)|uint32((d&0x03E0)>>2)<<8|uint32((d&0x001F)<<3)<<16|0xFF000000)
	}
}

// rgb565BatchToRGBA converts n big-endian RGB565 pixels to RGBA.
func rgb565BatchToRGBA(dst []byte, src []byte, n int) {
	for i := range n {
		d := binary.BigEndian.Uint16(src[i*2:])
		binary.LittleEndian.PutUint32(dst[i*4:],
			uint32((d&0xF800)>>8)|uint32((d&0x07E0)>>3)<<8|uint32((d&0x001F)<<3)<<16|0xFF000000)
	}
}
