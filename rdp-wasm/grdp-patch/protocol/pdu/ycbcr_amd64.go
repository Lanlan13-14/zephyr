//go:build amd64

package pdu

import "unsafe"

// ycoCgToBGRANoSub converts Y, Co, Cg planes to BGRA using SSE2.
// count = total pixel count. shift = colorLossLevel - 1.
// Alpha is always 0xFF (caller handles non-0xFF alpha separately).
func ycoCgToBGRANoSub(pixels []byte, yPlane, coPlane, cgPlane []byte, count int, shift uint8) {
	count8 := count &^ 7
	if count8 > 0 {
		ycoCgToBGRASSE2(
			unsafe.Pointer(&pixels[0]),
			unsafe.Pointer(&yPlane[0]),
			unsafe.Pointer(&coPlane[0]),
			unsafe.Pointer(&cgPlane[0]),
			count8, int(shift),
		)
	}
	for i := count8; i < count; i++ {
		yVal := int16(yPlane[i])
		coVal := int16(int8(byte(int16(coPlane[i]) << shift)))
		cgVal := int16(int8(byte(int16(cgPlane[i]) << shift)))
		off := i * 4
		pixels[off] = clampByte(yVal - coVal - cgVal)
		pixels[off+1] = clampByte(yVal + cgVal)
		pixels[off+2] = clampByte(yVal + coVal - cgVal)
		pixels[off+3] = 0xFF
	}
}

//go:noescape
func ycoCgToBGRASSE2(pixels, yPlane, coPlane, cgPlane unsafe.Pointer, count, shift int)
