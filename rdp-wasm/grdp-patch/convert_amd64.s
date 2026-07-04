// SSE2 implementations of bgr32toRGBAasm, rgb555toRGBAasm, and rgb565toRGBAasm.
// Each function processes 8 big-endian RGB pixels per loop iteration.
// Stack ABI (ABI0): dst+0(FP), src+8(FP), n+16(FP) — total 24 bytes.

#include "textflag.h"

// Packed-word masks used across both functions.
DATA rgb_00F8<>+0x00(SB)/8, $0x00F800F800F800F8
DATA rgb_00F8<>+0x08(SB)/8, $0x00F800F800F800F8
GLOBL rgb_00F8<>(SB), (NOPTR|RODATA), $16

DATA rgb_00FC<>+0x00(SB)/8, $0x00FC00FC00FC00FC
DATA rgb_00FC<>+0x08(SB)/8, $0x00FC00FC00FC00FC
GLOBL rgb_00FC<>(SB), (NOPTR|RODATA), $16

DATA rgb_FF00<>+0x00(SB)/8, $0xFF00FF00FF00FF00
DATA rgb_FF00<>+0x08(SB)/8, $0xFF00FF00FF00FF00
GLOBL rgb_FF00<>(SB), (NOPTR|RODATA), $16

// func rgb555toRGBAasm(dst *byte, src *byte, n int)
// Converts n big-endian RGB555 pixels to RGBA.
// R = (d>>7)&0xF8, G = (d>>2)&0xF8, B = (d<<3)&0xF8, A = 0xFF.
TEXT ·rgb555toRGBAasm(SB),NOSPLIT,$0-24
	MOVQ dst+0(FP), DI
	MOVQ src+8(FP), SI
	MOVQ n+16(FP), AX
	MOVOU rgb_00F8<>(SB), X13   // mask 0x00F8 in each 16-bit lane
	MOVOU rgb_FF00<>(SB), X14   // mask 0xFF00 in each 16-bit lane

loop555:
	// Load 16 bytes = 8 big-endian uint16 pixels.
	MOVOU (SI), X0

	// Byte-swap each 16-bit element: memory has [H,L] per pixel;
	// x86 loads give word = L<<8|H; we want d = H<<8|L.
	MOVO  X0, X1
	PSLLW $8, X0                // X0[i] = H<<8 (low byte cleared)
	PSRLW $8, X1                // X1[i] = L    (high byte cleared)
	POR   X1, X0                // X0[i] = H<<8|L = d

	// Extract R = (d>>7) & 0x00F8.
	MOVO  X0, X2
	PSRLW $7, X2
	PAND  X13, X2

	// Extract G = (d>>2) & 0x00F8.
	MOVO  X0, X3
	PSRLW $2, X3
	PAND  X13, X3

	// Extract B = (d<<3) & 0x00F8.
	MOVO  X0, X4
	PSLLW $3, X4
	PAND  X13, X4

	// Build RG word: G in high byte, R in low byte.
	MOVO  X3, X5
	PSLLW $8, X5                // G → high byte
	POR   X2, X5                // X5[i] = G<<8|R

	// Build BA word: 0xFF in high byte, B in low byte.
	MOVO  X4, X6
	POR   X14, X6               // X6[i] = 0xFF00|B

	// Interleave to produce 4 RGBA dwords each.
	// PUNPCKLWD src,dst → dst=[dst_w0,src_w0,dst_w1,src_w1,...dst_w3,src_w3]
	// Each dword becomes bytes [R,G,B,0xFF].
	MOVO       X5, X7
	PUNPCKLWD  X6, X5           // low 4 pixels  → X5
	PUNPCKHWD  X6, X7           // high 4 pixels → X7

	MOVOU X5, (DI)
	MOVOU X7, 16(DI)

	ADDQ $16, SI
	ADDQ $32, DI
	SUBQ $8, AX
	JNZ  loop555
	RET

// func rgb565toRGBAasm(dst *byte, src *byte, n int)
// Converts n big-endian RGB565 pixels to RGBA.
// R = (d>>8)&0xF8, G = (d>>3)&0xFC, B = (d<<3)&0xF8, A = 0xFF.
TEXT ·rgb565toRGBAasm(SB),NOSPLIT,$0-24
	MOVQ dst+0(FP), DI
	MOVQ src+8(FP), SI
	MOVQ n+16(FP), AX
	MOVOU rgb_00F8<>(SB), X13
	MOVOU rgb_00FC<>(SB), X15
	MOVOU rgb_FF00<>(SB), X14

loop565:
	MOVOU (SI), X0

	MOVO  X0, X1
	PSLLW $8, X0
	PSRLW $8, X1
	POR   X1, X0                // X0[i] = d

	// R = (d>>8) & 0x00F8.
	MOVO  X0, X2
	PSRLW $8, X2
	PAND  X13, X2

	// G = (d>>3) & 0x00FC.
	MOVO  X0, X3
	PSRLW $3, X3
	PAND  X15, X3

	// B = (d<<3) & 0x00F8.
	MOVO  X0, X4
	PSLLW $3, X4
	PAND  X13, X4

	MOVO  X3, X5
	PSLLW $8, X5
	POR   X2, X5                // X5[i] = G<<8|R

	MOVO  X4, X6
	POR   X14, X6               // X6[i] = 0xFF00|B

	MOVO       X5, X7
	PUNPCKLWD  X6, X5
	PUNPCKHWD  X6, X7

	MOVOU X5, (DI)
	MOVOU X7, 16(DI)

	ADDQ $16, SI
	ADDQ $32, DI
	SUBQ $8, AX
	JNZ  loop565
	RET

// Dword-lane masks for bgr32toRGBAasm.
// bgr32_lo: 0x000000FF in each 32-bit lane — isolates the low byte (B or R after shift).
DATA bgr32_lo<>+0x00(SB)/8, $0x000000FF000000FF
DATA bgr32_lo<>+0x08(SB)/8, $0x000000FF000000FF
GLOBL bgr32_lo<>(SB), (NOPTR|RODATA), $16

// bgr32_gg: 0x0000FF00 in each 32-bit lane — isolates the G byte.
DATA bgr32_gg<>+0x00(SB)/8, $0x0000FF000000FF00
DATA bgr32_gg<>+0x08(SB)/8, $0x0000FF000000FF00
GLOBL bgr32_gg<>(SB), (NOPTR|RODATA), $16

// bgr32_aa: 0xFF000000 in each 32-bit lane — supplies the alpha byte.
DATA bgr32_aa<>+0x00(SB)/8, $0xFF000000FF000000
DATA bgr32_aa<>+0x08(SB)/8, $0xFF000000FF000000
GLOBL bgr32_aa<>(SB), (NOPTR|RODATA), $16

// func bgr32toRGBAasm(dst *byte, src *byte, n int)
// Converts n BGRA32 pixels (memory layout B,G,R,X per pixel) to RGBA
// (memory layout R,G,B,0xFF).  Processes 8 pixels (32 bytes) per iteration.
// Source dword in register (LE): bits[7:0]=B, bits[15:8]=G, bits[23:16]=R, bits[31:24]=X.
// Dest  dword in register (LE): bits[7:0]=R, bits[15:8]=G, bits[23:16]=B, bits[31:24]=FF.
TEXT ·bgr32toRGBAasm(SB),NOSPLIT,$0-24
	MOVQ dst+0(FP), DI
	MOVQ src+8(FP), SI
	MOVQ n+16(FP), AX
	MOVOU bgr32_lo<>(SB), X12   // 0x000000FF per dword
	MOVOU bgr32_gg<>(SB), X13   // 0x0000FF00 per dword
	MOVOU bgr32_aa<>(SB), X14   // 0xFF000000 per dword

loop32:
	// ---- pixels 0–3 (16 bytes at SI) ----
	MOVOU (SI), X0

	// R = (src >> 16) & 0xFF  →  low byte of dest dword.
	MOVO  X0, X2
	PSRLD $16, X2
	PAND  X12, X2               // X2 = [R,0,0,0] per dword

	// G stays at byte 1: src & 0x0000FF00.
	MOVO  X0, X3
	PAND  X13, X3               // X3 = [0,G,0,0] per dword

	// B moves from byte 0 to byte 2: (src & 0xFF) << 16.
	MOVO  X0, X4
	PAND  X12, X4
	PSLLD $16, X4               // X4 = [0,0,B,0] per dword

	POR   X3, X2
	POR   X4, X2
	POR   X14, X2               // X2 = [R,G,B,FF] per dword
	MOVOU X2, (DI)

	// ---- pixels 4–7 (next 16 bytes) ----
	MOVOU 16(SI), X0

	MOVO  X0, X2
	PSRLD $16, X2
	PAND  X12, X2

	MOVO  X0, X3
	PAND  X13, X3

	MOVO  X0, X4
	PAND  X12, X4
	PSLLD $16, X4

	POR   X3, X2
	POR   X4, X2
	POR   X14, X2
	MOVOU X2, 16(DI)

	ADDQ $32, SI
	ADDQ $32, DI
	SUBQ $8, AX
	JNZ  loop32
	RET
