//go:build !amd64 && !arm64

package pdu

// ycoCgToBGRANoSub converts count pixels from YCoCg planes to interleaved BGRA,
// assuming no chroma subsampling and no alpha plane override.
// pixels must have capacity >= count*4.
func ycoCgToBGRANoSub(pixels, yPlane, coPlane, cgPlane []byte, count int, shift uint8) {
	i := 0
	for ; i+4 <= count; i += 4 {
		off := i * 4

		yVal := int16(yPlane[i])
		coVal := int16(int8(byte(int16(coPlane[i]) << shift)))
		cgVal := int16(int8(byte(int16(cgPlane[i]) << shift)))
		pixels[off] = clampByte(yVal - coVal - cgVal)
		pixels[off+1] = clampByte(yVal + cgVal)
		pixels[off+2] = clampByte(yVal + coVal - cgVal)
		pixels[off+3] = 0xFF

		yVal = int16(yPlane[i+1])
		coVal = int16(int8(byte(int16(coPlane[i+1]) << shift)))
		cgVal = int16(int8(byte(int16(cgPlane[i+1]) << shift)))
		pixels[off+4] = clampByte(yVal - coVal - cgVal)
		pixels[off+5] = clampByte(yVal + cgVal)
		pixels[off+6] = clampByte(yVal + coVal - cgVal)
		pixels[off+7] = 0xFF

		yVal = int16(yPlane[i+2])
		coVal = int16(int8(byte(int16(coPlane[i+2]) << shift)))
		cgVal = int16(int8(byte(int16(cgPlane[i+2]) << shift)))
		pixels[off+8] = clampByte(yVal - coVal - cgVal)
		pixels[off+9] = clampByte(yVal + cgVal)
		pixels[off+10] = clampByte(yVal + coVal - cgVal)
		pixels[off+11] = 0xFF

		yVal = int16(yPlane[i+3])
		coVal = int16(int8(byte(int16(coPlane[i+3]) << shift)))
		cgVal = int16(int8(byte(int16(cgPlane[i+3]) << shift)))
		pixels[off+12] = clampByte(yVal - coVal - cgVal)
		pixels[off+13] = clampByte(yVal + cgVal)
		pixels[off+14] = clampByte(yVal + coVal - cgVal)
		pixels[off+15] = 0xFF
	}
	for ; i < count; i++ {
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
