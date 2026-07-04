package rdpgfx

import (
	"testing"
)

// BenchmarkIctToBGRA benchmarks ictToBGRA on a full 64×64 tile row (64 pixels).
func BenchmarkIctToBGRA(b *testing.B) {
	n := rfxTileSize // 64 pixels per row
	yRow := make([]int16, n)
	cbRow := make([]int16, n)
	crRow := make([]int16, n)
	dst := make([]byte, n*4)
	for i := range n {
		yRow[i] = int16(i * 4)
		cbRow[i] = int16(i%64 - 32)
		crRow[i] = int16(i%32 - 16)
	}
	b.ResetTimer()
	for b.Loop() {
		ictToBGRA(yRow, cbRow, crRow, dst, n)
	}
}

// BenchmarkRfxDecodeComponent benchmarks a full component decode pipeline:
// RLGR → differential/dequantize → inverse DWT.
func BenchmarkRfxDecodeComponent(b *testing.B) {
	// Use the same coefficient pattern as the RLGR benchmarks (1/17 non-zero).
	coeffs := make([]int16, 4096)
	for i := range coeffs {
		if i%17 == 0 {
			coeffs[i] = int16(i%256 - 128)
		}
	}
	data := rlgr1Encode(coeffs)
	quant := rfxQuant{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}

	b.ResetTimer()
	var dst []int16
	for b.Loop() {
		dst = rfxDecodeComponent(data, quant, 1)
		coeffPool.Put((*coeffArr)(dst))
		dst = nil
	}
}

// BenchmarkRfxInverseDWT2D benchmarks the full 3-level inverse DWT on 4096 coefficients.
func BenchmarkRfxInverseDWT2D(b *testing.B) {
	coeffs := make([]int16, 4096)
	for i := range coeffs {
		coeffs[i] = int16(i%64 - 32)
	}
	b.ResetTimer()
	for b.Loop() {
		rfxInverseDWT2D(coeffs)
	}
}
