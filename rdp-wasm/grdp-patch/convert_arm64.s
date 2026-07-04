// NEON implementations of rgb555toRGBAarm64 and rgb565toRGBAarm64.
// Processes 8 big-endian RGB pixels per loop iteration.
// Stack ABI (ABI0): dst+0(FP), src+8(FP), n+16(FP) — total 24 bytes.
//
// Instruction notes (Go arm64 assembler requires V-prefix for NEON):
//   VUSHR/VSHL  = unsigned shift right/left by immediate on vector register
//   VUZP1       = unzip even elements; used here to narrow H8→B8 (XTN equivalent)
//   VZIP1/VZIP2 = interleave lower/upper halves of two vector registers
//   VMOVI $n, Vd.B16 = broadcast 8-bit immediate to all 16 byte lanes

#include "textflag.h"

// func rgb555toRGBAarm64(dst *byte, src *byte, n int)
TEXT ·rgb555toRGBAarm64(SB),NOSPLIT,$0-24
	MOVD dst+0(FP), R0
	MOVD src+8(FP), R1
	MOVD n+16(FP), R2

	// V14 = 0xF8 in every byte (5-bit channel mask).
	// V13 = 0xFF in every byte (alpha).
	VMOVI $0xF8, V14.B16
	VMOVI $0xFF, V13.B16

loop555:
	// Load 16 bytes (8 big-endian uint16 pixels); post-increment R1 by 16.
	VLD1.P 16(R1), [V0.B16]

	// Byte-swap each 16-bit element: big-endian → native uint16.
	// Memory: [H0,L0,H1,L1,...]; after VREV16: V0.H[i] = H_i<<8|L_i = d_i.
	VREV16 V0.B16, V0.B16

	// Extract R = (d>>7) & 0xF8:  d bits[14:10] → output bits[7:3].
	// VUSHR gives V1.H[i]=d>>7; VAND zeros high byte; VUZP1 narrows to B8.
	VUSHR $7, V0.H8, V1.H8
	VAND  V14.B16, V1.B16, V1.B16
	VUZP1 V1.B16, V1.B16, V2.B16   // V2.B[0..7] = R0..R7

	// Extract G = (d>>2) & 0xF8:  d bits[9:5] → output bits[7:3].
	VUSHR $2, V0.H8, V1.H8
	VAND  V14.B16, V1.B16, V1.B16
	VUZP1 V1.B16, V1.B16, V3.B16   // V3.B[0..7] = G0..G7

	// Extract B = (d<<3) & 0xF8:  d bits[4:0] → output bits[7:3].
	VSHL  $3, V0.H8, V1.H8
	VAND  V14.B16, V1.B16, V1.B16
	VUZP1 V1.B16, V1.B16, V4.B16   // V4.B[0..7] = B0..B7

	// Interleave R and G: [R0,G0,R1,G1,...,R7,G7] (uses lower 8 bytes of each).
	VZIP1 V2.B16, V3.B16, V5.B16

	// Interleave B and alpha: [B0,FF,B1,FF,...,B7,FF].
	VZIP1 V4.B16, V13.B16, V6.B16

	// Interleave RG and BA halfwords to form RGBA dwords.
	VZIP1 V5.H8, V6.H8, V7.H8   // V7 = first 4 RGBA pixels
	VZIP2 V5.H8, V6.H8, V8.H8   // V8 = last  4 RGBA pixels

	// Store 32 bytes to dst; post-increment R0 by 32.
	VST1.P [V7.B16, V8.B16], 32(R0)

	SUBS $8, R2, R2
	BNE  loop555
	RET

// func rgb565toRGBAarm64(dst *byte, src *byte, n int)
TEXT ·rgb565toRGBAarm64(SB),NOSPLIT,$0-24
	MOVD dst+0(FP), R0
	MOVD src+8(FP), R1
	MOVD n+16(FP), R2

	VMOVI $0xF8, V14.B16   // 5-bit channel mask (R and B)
	VMOVI $0xFC, V12.B16   // 6-bit channel mask (G)
	VMOVI $0xFF, V13.B16   // alpha

loop565:
	VLD1.P 16(R1), [V0.B16]
	VREV16 V0.B16, V0.B16

	// R = (d>>8) & 0xF8:  d bits[15:11] → output bits[7:3].
	VUSHR $8, V0.H8, V1.H8
	VAND  V14.B16, V1.B16, V1.B16
	VUZP1 V1.B16, V1.B16, V2.B16   // V2.B[0..7] = R0..R7

	// G = (d>>3) & 0xFC:  d bits[10:5] → output bits[7:2].
	VUSHR $3, V0.H8, V1.H8
	VAND  V12.B16, V1.B16, V1.B16
	VUZP1 V1.B16, V1.B16, V3.B16   // V3.B[0..7] = G0..G7

	// B = (d<<3) & 0xF8:  d bits[4:0] → output bits[7:3].
	VSHL  $3, V0.H8, V1.H8
	VAND  V14.B16, V1.B16, V1.B16
	VUZP1 V1.B16, V1.B16, V4.B16   // V4.B[0..7] = B0..B7

	VZIP1 V2.B16, V3.B16, V5.B16
	VZIP1 V4.B16, V13.B16, V6.B16

	VZIP1 V5.H8, V6.H8, V7.H8
	VZIP2 V5.H8, V6.H8, V8.H8

	VST1.P [V7.B16, V8.B16], 32(R0)

	SUBS $8, R2, R2
	BNE  loop565
	RET

// bgr32_s4_lo: 0x000000FF in each 32-bit lane — isolates the low byte (B or R after shift).
DATA bgr32_s4_lo<>+0x00(SB)/8, $0x000000FF000000FF
DATA bgr32_s4_lo<>+0x08(SB)/8, $0x000000FF000000FF
GLOBL bgr32_s4_lo<>(SB), (NOPTR|RODATA), $16

// bgr32_s4_gg: 0x0000FF00 in each 32-bit lane — isolates the G byte.
DATA bgr32_s4_gg<>+0x00(SB)/8, $0x0000FF000000FF00
DATA bgr32_s4_gg<>+0x08(SB)/8, $0x0000FF000000FF00
GLOBL bgr32_s4_gg<>(SB), (NOPTR|RODATA), $16

// bgr32_s4_aa: 0xFF000000 in each 32-bit lane — supplies the alpha byte.
DATA bgr32_s4_aa<>+0x00(SB)/8, $0xFF000000FF000000
DATA bgr32_s4_aa<>+0x08(SB)/8, $0xFF000000FF000000
GLOBL bgr32_s4_aa<>(SB), (NOPTR|RODATA), $16

// func bgr32toRGBAarm64(dst *byte, src *byte, n int)
// Converts n BGRA32 pixels (memory layout B,G,R,X per pixel) to RGBA
// (memory layout R,G,B,0xFF).  Processes 8 pixels (32 bytes) per iteration.
//
// Strategy (mirrors amd64 SSE2 implementation — per-dword shift+mask):
//   Source dword (LE register): bits[7:0]=B, bits[15:8]=G, bits[23:16]=R, bits[31:24]=X
//   Dest  dword (LE register): bits[7:0]=R, bits[15:8]=G, bits[23:16]=B, bits[31:24]=FF
//   R = (src >> 16) & 0x000000FF
//   G = src & 0x0000FF00
//   B = (src & 0x000000FF) << 16
//   A = 0xFF000000
TEXT ·bgr32toRGBAarm64(SB),NOSPLIT,$0-24
	MOVD dst+0(FP), R0
	MOVD src+8(FP), R1
	MOVD n+16(FP), R2

	MOVD $bgr32_s4_lo<>(SB), R10
	VLD1 (R10), [V15.B16]   // V15 = 0x000000FF per dword
	MOVD $bgr32_s4_gg<>(SB), R10
	VLD1 (R10), [V14.B16]   // V14 = 0x0000FF00 per dword
	MOVD $bgr32_s4_aa<>(SB), R10
	VLD1 (R10), [V13.B16]   // V13 = 0xFF000000 per dword

loop32:
	// pixels 0-3
	VLD1.P 16(R1), [V0.B16]
	VUSHR $16, V0.S4, V1.S4         // V1 = src >> 16 per dword
	VAND  V15.B16, V1.B16, V1.B16   // V1 = [R,0,0,0] per dword
	VAND  V14.B16, V0.B16, V2.B16   // V2 = [0,G,0,0] per dword
	VAND  V15.B16, V0.B16, V3.B16   // V3 = [B,0,0,0] per dword
	VSHL  $16, V3.S4, V3.S4         // V3 = [0,0,B,0] per dword
	VORR  V2.B16, V1.B16, V1.B16
	VORR  V3.B16, V1.B16, V1.B16
	VORR  V13.B16, V1.B16, V1.B16   // V1 = [R,G,B,FF] per dword
	VST1.P [V1.B16], 16(R0)

	// pixels 4-7
	VLD1.P 16(R1), [V0.B16]
	VUSHR $16, V0.S4, V1.S4
	VAND  V15.B16, V1.B16, V1.B16
	VAND  V14.B16, V0.B16, V2.B16
	VAND  V15.B16, V0.B16, V3.B16
	VSHL  $16, V3.S4, V3.S4
	VORR  V2.B16, V1.B16, V1.B16
	VORR  V3.B16, V1.B16, V1.B16
	VORR  V13.B16, V1.B16, V1.B16
	VST1.P [V1.B16], 16(R0)

	SUBS $8, R2, R2
	BNE  loop32
	RET
