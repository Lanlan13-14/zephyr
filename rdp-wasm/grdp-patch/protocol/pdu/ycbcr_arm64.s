// Scalar ARM64 implementation of ycoCgToBGRANEON.
// Processes one pixel per iteration (no chroma subsampling, alpha = 0xFF).
// Go arm64 assembler lacks SSHR (signed vector shift right), SSHL (by register),
// and SQXTUN (saturating narrow), so we use scalar GP instructions instead.
// Stack ABI (ABI0):
//   pixels+0(FP)   unsafe.Pointer
//   yPlane+8(FP)   unsafe.Pointer
//   coPlane+16(FP) unsafe.Pointer
//   cgPlane+24(FP) unsafe.Pointer
//   count+32(FP)   int
//   shift+40(FP)   int

#include "textflag.h"

// func ycoCgToBGRANEON(pixels, yPlane, coPlane, cgPlane unsafe.Pointer, count, shift int)
TEXT ·ycoCgToBGRANEON(SB),NOSPLIT,$0-48
	MOVD pixels+0(FP),   R0   // dst
	MOVD yPlane+8(FP),   R1   // Y plane
	MOVD coPlane+16(FP), R2   // Co plane
	MOVD cgPlane+24(FP), R3   // Cg plane
	MOVD count+32(FP),   R4   // pixel count
	MOVD shift+40(FP),   R5   // shift amount

	CBZ  R4, done

	MOVD $0,   R12   // const 0
	MOVD $255, R13   // const 255

loop:
	MOVBU (R1), R6   // y  = Y[i]
	MOVBU (R2), R7   // co = Co[i]
	MOVBU (R3), R8   // cg = Cg[i]
	ADD   $1, R1
	ADD   $1, R2
	ADD   $1, R3

	// coVal = int8(co << shift): shift left, then sign-extend low byte.
	LSL  R5, R7, R7     // R7 = co << shift  (low 8 bits hold result)
	SXTB R7, R7         // R7 = int64(int8(R7))

	// cgVal = int8(cg << shift)
	LSL  R5, R8, R8
	SXTB R8, R8

	// B = clamp(y - co - cg)
	SUB  R7, R6, R9     // R9 = y - co
	SUB  R8, R9, R9     // R9 = y - co - cg
	CMP  R12, R9
	CSEL LT, R12, R9, R9
	CMP  R13, R9
	CSEL GT, R13, R9, R9

	// G = clamp(y + cg)
	ADD  R8, R6, R10    // R10 = y + cg
	CMP  R12, R10
	CSEL LT, R12, R10, R10
	CMP  R13, R10
	CSEL GT, R13, R10, R10

	// R = clamp(y + co - cg)
	ADD  R7, R6, R11    // R11 = y + co
	SUB  R8, R11, R11   // R11 = y + co - cg
	CMP  R12, R11
	CSEL LT, R12, R11, R11
	CMP  R13, R11
	CSEL GT, R13, R11, R11

	// Store BGRA pixel.
	MOVBU R9, 0(R0)
	MOVBU R10, 1(R0)
	MOVBU R11, 2(R0)
	MOVBU R13, 3(R0)    // alpha = 255
	ADD  $4, R0

	SUBS $1, R4, R4
	BNE  loop

done:
	RET
