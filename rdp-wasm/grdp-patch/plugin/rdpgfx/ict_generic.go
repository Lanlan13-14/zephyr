//go:build !arm64

package rdpgfx

func mulHiI16(a, b int16) int16 {
	return int16((int32(a) * int32(b)) >> 16)
}

func ictPixel(v int32) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

func ictToBGRA(yRow, cbRow, crRow []int16, dst []byte, n int) {
	// FreeRDP's x86 production path processes complete groups of 16 with
	// SSE2 fixed-point arithmetic. Reproduce its int16 wrapping, signed
	// high-word multiply and shifts exactly so WASM and FreeRDP agree.
	full := n - n%16
	for i := 0; i < full; i++ {
		y := int16(yRow[i] + 4096)
		y >>= 2
		cb, cr := cbRow[i], crRow[i]
		r := int16(y + mulHiI16(cr, 22987))
		g := int16(y + mulHiI16(cb, -5636))
		g = int16(g + mulHiI16(cr, -11698))
		b := int16(y + mulHiI16(cb, 29000))
		r >>= 3
		g >>= 3
		b >>= 3
		p := dst[i*4 : i*4+4]
		p[0] = ictPixel(int32(b))
		p[1] = ictPixel(int32(g))
		p[2] = ictPixel(int32(r))
		p[3] = 0xFF
	}
	for i := full; i < n; i++ {
		y := int32(yRow[i]) + 4096
		ys := int32(uint32(y) << 16)
		cb, cr := int32(cbRow[i]), int32(crRow[i])
		r := int16(((cr*91916 + ys) >> 16) >> 5)
		g := int16(((ys - cb*22527 - cr*46819) >> 16) >> 5)
		b := int16(((cb*115992 + ys) >> 16) >> 5)
		p := dst[i*4 : i*4+4]
		p[0] = ictPixel(int32(b))
		p[1] = ictPixel(int32(g))
		p[2] = ictPixel(int32(r))
		p[3] = 0xFF
	}
}
