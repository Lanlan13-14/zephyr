//go:build arm64

package rdpgfx

import "unsafe"

// ictToBGRANEON processes n pixels (n must be a multiple of 8) converting
// int16 YCbCr planes to packed BGRA using the ICT formula.  Implemented as
// ARMv8-A NEON assembly for throughput.
//
//go:noescape
func ictToBGRANEON(y, cb, cr, dst unsafe.Pointer, n int)

// ictToBGRA dispatches to the NEON path for full 8-pixel batches and falls
// back to scalar arithmetic for any remaining pixels.
func ictToBGRA(yRow, cbRow, crRow []int16, dst []byte, n int) {
	full := (n / 8) * 8
	if full > 0 {
		ictToBGRANEON(
			unsafe.Pointer(&yRow[0]),
			unsafe.Pointer(&cbRow[0]),
			unsafe.Pointer(&crRow[0]),
			unsafe.Pointer(&dst[0]),
			full,
		)
	}
	for col := full; col < n; col++ {
		yv := int32(yRow[col])
		cb := int32(cbRow[col])
		cr := int32(crRow[col])
		ys := (yv + 4096) << 16
		bv := uint32(max(0, min((cb*115992+ys)>>21, 255)))
		gv := uint32(max(0, min((ys-cb*22527-cr*46819)>>21, 255)))
		rv := uint32(max(0, min((cr*91916+ys)>>21, 255)))
		*(*uint32)(unsafe.Pointer(&dst[col*4])) = bv | gv<<8 | rv<<16 | 0xFF000000
	}
}
