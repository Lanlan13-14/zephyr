//go:build !arm64

package rdpgfx

import "unsafe"

// ictToBGRA converts n pixels from YCbCr (ICT) to BGRA and writes them into
// dst (which must hold ≥ 4*n bytes).  Processing n pixels in [8]int32 arrays
// with a scalar inner loop.
func ictToBGRA(yRow, cbRow, crRow []int16, dst []byte, n int) {
	const batch = 8
	full := (n / batch) * batch
	for base := 0; base < full; base += batch {
		var yv, cb, cr [batch]int32
		for k := range batch {
			yv[k] = int32(yRow[base+k])
			cb[k] = int32(cbRow[base+k])
			cr[k] = int32(crRow[base+k])
		}
		for k := range batch {
			ys := (yv[k] + 4096) << 16
			bv := uint32(max(0, min((cb[k]*115992+ys)>>21, 255)))
			gv := uint32(max(0, min((ys-cb[k]*22527-cr[k]*46819)>>21, 255)))
			rv := uint32(max(0, min((cr[k]*91916+ys)>>21, 255)))
			*(*uint32)(unsafe.Pointer(&dst[(base+k)*4])) = bv | gv<<8 | rv<<16 | 0xFF000000
		}
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
