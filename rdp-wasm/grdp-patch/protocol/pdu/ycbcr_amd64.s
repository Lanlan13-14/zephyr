// SSE2 implementation of ycoCgToBGRASSE2.
// Processes 8 pixels per iteration (no chroma subsampling, alpha = 0xFF).
// Stack ABI (ABI0):
//   pixels+0(FP)   unsafe.Pointer  (dst, BGRA output)
//   yPlane+8(FP)   unsafe.Pointer
//   coPlane+16(FP) unsafe.Pointer
//   cgPlane+24(FP) unsafe.Pointer
//   count+32(FP)   int             (multiple of 8)
//   shift+40(FP)   int

#include "textflag.h"

// func ycoCgToBGRASSE2(pixels, yPlane, coPlane, cgPlane unsafe.Pointer, count, shift int)
TEXT ·ycoCgToBGRASSE2(SB),NOSPLIT,$0-48
	MOVQ pixels+0(FP),  DI
	MOVQ yPlane+8(FP),  SI
	MOVQ coPlane+16(FP), BX
	MOVQ cgPlane+24(FP), R8
	MOVQ count+32(FP),  CX
	MOVQ shift+40(FP),  AX

	// Build XMM shift count = shift+8 in low 64 bits (used by PSLLW).
	ADDQ $8, AX
	MOVQ AX, X12               // X12 = shift+8 (PSLLW count register)

	PXOR X7, X7                // X7  = zero vector (for zero-extension)

	SHRQ $3, CX                // CX  = count/8 (loop iterations)

loop_yco:
	// Load 8 Y bytes; zero-extend each to uint16.
	MOVQ  (SI), X1             // X1[63:0] = 8 Y bytes
	PUNPCKLBW X7, X1           // X1 = uint16[0..7] Y values (0-255)

	// Load 8 Co bytes; zero-extend then sign-extend with shift:
	//   coVal = int16(int8(byte(uint16(co) << shift)))
	//         = (uint16(co) << (shift+8)) >> 8  [arithmetic]
	MOVQ  (BX), X2
	PUNPCKLBW X7, X2           // X2 = uint16 co values
	PSLLW X12, X2              // X2 <<= shift+8
	PSRAW $8, X2               // X2 = signed int16 coVal

	// Same for Cg.
	MOVQ  (R8), X3
	PUNPCKLBW X7, X3
	PSLLW X12, X3
	PSRAW $8, X3               // X3 = signed int16 cgVal

	// B = Y - Co - Cg.
	MOVO X1, X4
	PSUBW X2, X4
	PSUBW X3, X4

	// G = Y + Cg.
	MOVO X1, X5
	PADDW X3, X5

	// R = Y + Co - Cg.
	MOVO X1, X6
	PADDW X2, X6
	PSUBW X3, X6

	// Pack B and G to uint8 with unsigned saturation (clamp to [0,255]):
	// PACKUSWB dst,src: dst = [sat_u8(dst[0..7]), sat_u8(src[0..7])]
	// After: X4 = [B0..B7, G0..G7]
	PACKUSWB X5, X4

	// Pack R and 0xFF-alpha:
	// PCMPEQB X10,X10 → all bits 1 = 0xFF per byte.
	PCMPEQB X10, X10           // X10 = 0xFF...FF
	PACKUSWB X10, X6           // X6  = [R0..R7, FF..FF]

	// Interleave B and G bytes: [B0,G0,B1,G1,...,B7,G7].
	// X4 = [B0..B7 | G0..G7]; shift copy right 8 bytes → [G0..G7 | 0..0].
	MOVO  X4, X8
	PSRLDQ $8, X8              // X8 = [G0..G7, 0..0]
	PUNPCKLBW X8, X4           // X4 = [B0,G0,B1,G1,...,B7,G7]

	// Interleave R and alpha bytes: [R0,FF,R1,FF,...,R7,FF].
	MOVO  X6, X9
	PSRLDQ $8, X9              // X9 = [FF..FF, 0..0]
	PUNPCKLBW X9, X6           // X6 = [R0,FF,R1,FF,...,R7,FF]

	// Interleave BG and RA halfwords to produce BGRA dwords:
	// PUNPCKLWD: low 4 words → [BG0,RA0,BG1,RA1,BG2,RA2,BG3,RA3]
	//           = bytes [B0,G0,R0,FF, B1,G1,R1,FF, B2,G2,R2,FF, B3,G3,R3,FF]
	MOVO      X4, X11
	PUNPCKLWD X6, X11          // X11 = low  4 BGRA pixels
	PUNPCKHWD X6, X4           // X4  = high 4 BGRA pixels

	MOVOU X11, (DI)
	MOVOU X4,  16(DI)

	ADDQ $8,  SI
	ADDQ $8,  BX
	ADDQ $8,  R8
	ADDQ $32, DI
	DECQ CX
	JNZ  loop_yco
	RET
