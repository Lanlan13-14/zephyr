// ARM64 NEON implementation of the ICT (Irreversible Color Transform) inverse
// for RemoteFX tiles: converts Y/Cb/Cr int16 planes to packed BGRA uint8.
//
// The Go arm64 assembler does not expose SSHLL, SSHR, SQXTN, SQXTUN, MUL, or
// MLA as named mnemonics, so each of those instructions is emitted as a raw
// 32-bit WORD constant with the ARMv8-A encoding.  All encodings were derived
// by assembling the equivalent C-style mnemonics with the system `as` tool and
// confirmed by inspecting the resulting object file.
//
// Register map:
//   R0  – y plane pointer  (advances 16 bytes per iteration)
//   R1  – cb plane pointer
//   R2  – cr plane pointer
//   R3  – dst BGRA pointer (advances 32 bytes per iteration)
//   R4  – iteration count  (= n/8 on entry)
//   R5  – scratch GP register (used only during constant setup)
//
//   V0  – y[0..7]   int16 raw (8H)
//   V1  – cb[0..7]  int16 raw (8H)
//   V2  – cr[0..7]  int16 raw (8H)
//   V3  – y_lo[0..3] int32   (4S)   | sign-extended from lower 4 lanes of V0
//   V4  – y_hi[4..7] int32   (4S)   | sign-extended from upper 4 lanes of V0
//   V5  – cb_lo      int32   (4S)
//   V6  – cb_hi      int32   (4S)
//   V7  – cr_lo      int32   (4S)
//   V8  – cr_hi      int32   (4S)
//   V9  – ys_lo = (y_lo + 4096) << 16   (4S) – intermediate
//   V10 – ys_hi                          (4S)
//   V11 – const { 4096, ... }  (4S)  ─┐
//   V12 – const { 115992, ... }       │ loaded once before loop
//   V13 – const { 22527, ... }        │
//   V14 – const { 46819, ... }        │
//   V15 – const { 91916, ... }  (4S)  ┘
//   V16 – B lo (4S), then packed B (4H → 8B)
//   V17 – B hi (4S)
//   V18 – G lo (4S)
//   V19 – G hi (4S)
//   V20 – R lo (4S)
//   V21 – R hi (4S)
//   V25 – B uint8[8] after saturation
//   V26 – G uint8[8]
//   V27 – R uint8[8]
//   V28 – alpha = 0xFF (8B) – constant, preserved across iterations
//
// Stack ABI (ABI0):
//   y+0(FP)   unsafe.Pointer
//   cb+8(FP)  unsafe.Pointer
//   cr+16(FP) unsafe.Pointer
//   dst+24(FP) unsafe.Pointer
//   n+32(FP)  int

#include "textflag.h"

// func ictToBGRANEON(y, cb, cr, dst unsafe.Pointer, n int)
TEXT ·ictToBGRANEON(SB),NOSPLIT,$0-40
	MOVD y+0(FP),   R0
	MOVD cb+8(FP),  R1
	MOVD cr+16(FP), R2
	MOVD dst+24(FP), R3
	MOVD n+32(FP),  R4

	// alpha constant: V28.8B = {0xFF, ...}
	WORD $0x0f07e7fc             // movi v28.8b, #0xff

	// Load ICT coefficients into V11-V15.
	MOVD $4096, R5
	WORD $0x4e040cab             // dup v11.4s, w5  (Y bias)
	MOVD $115992, R5
	WORD $0x4e040cac             // dup v12.4s, w5  (Cb → B)
	MOVD $22527, R5
	WORD $0x4e040cad             // dup v13.4s, w5  (Cb → G, subtracted)
	MOVD $46819, R5
	WORD $0x4e040cae             // dup v14.4s, w5  (Cr → G, subtracted)
	MOVD $91916, R5
	WORD $0x4e040caf             // dup v15.4s, w5  (Cr → R)

	// R4 = number of 8-pixel batches.
	LSR $3, R4, R4
	CBZ R4, done

loop:
	// ── Load 8 int16 pixels from each plane ──────────────────────────────
	WORD $0x4cdf7400             // ld1 {v0.8h}, [x0], #16
	WORD $0x4cdf7421             // ld1 {v1.8h}, [x1], #16
	WORD $0x4cdf7442             // ld1 {v2.8h}, [x2], #16

	// ── Sign-extend int16 → int32 ─────────────────────────────────────────
	WORD $0x0f10a403             // sshll  v3.4s,  v0.4h, #0   y_lo
	WORD $0x4f10a404             // sshll2 v4.4s,  v0.8h, #0   y_hi
	WORD $0x0f10a425             // sshll  v5.4s,  v1.4h, #0   cb_lo
	WORD $0x4f10a426             // sshll2 v6.4s,  v1.8h, #0   cb_hi
	WORD $0x0f10a447             // sshll  v7.4s,  v2.4h, #0   cr_lo
	WORD $0x4f10a448             // sshll2 v8.4s,  v2.8h, #0   cr_hi

	// ── ys = (y + 4096) << 16 ─────────────────────────────────────────────
	WORD $0x4eab8469             // add v9.4s,  v3.4s,  v11.4s
	WORD $0x4eab848a             // add v10.4s, v4.4s,  v11.4s
	WORD $0x4f305529             // shl v9.4s,  v9.4s,  #16
	WORD $0x4f30554a             // shl v10.4s, v10.4s, #16

	// ── B = ys + cb * 115992 ──────────────────────────────────────────────
	WORD $0x4ea91d30             // mov v16.16b, v9.16b   (b_lo = ys_lo)
	WORD $0x4eaa1d51             // mov v17.16b, v10.16b  (b_hi = ys_hi)
	WORD $0x4eac94b0             // mla v16.4s, v5.4s,  v12.4s
	WORD $0x4eac94d1             // mla v17.4s, v6.4s,  v12.4s

	// ── G = ys - cb*22527 - cr*46819 ──────────────────────────────────────
	WORD $0x4ea91d32             // mov v18.16b, v9.16b   (g_lo = ys_lo)
	WORD $0x4eaa1d53             // mov v19.16b, v10.16b  (g_hi = ys_hi)
	WORD $0x4ead9ca0             // mul v0.4s,  v5.4s,  v13.4s  (cb_lo*22527)
	WORD $0x6ea08652             // sub v18.4s, v18.4s, v0.4s
	WORD $0x4eae9ce0             // mul v0.4s,  v7.4s,  v14.4s  (cr_lo*46819)
	WORD $0x6ea08652             // sub v18.4s, v18.4s, v0.4s
	WORD $0x4ead9cc1             // mul v1.4s,  v6.4s,  v13.4s  (cb_hi*22527)
	WORD $0x6ea18673             // sub v19.4s, v19.4s, v1.4s
	WORD $0x4eae9d01             // mul v1.4s,  v8.4s,  v14.4s  (cr_hi*46819)
	WORD $0x6ea18673             // sub v19.4s, v19.4s, v1.4s

	// ── R = ys + cr * 91916 ───────────────────────────────────────────────
	WORD $0x4ea91d34             // mov v20.16b, v9.16b   (r_lo = ys_lo)
	WORD $0x4eaa1d55             // mov v21.16b, v10.16b  (r_hi = ys_hi)
	WORD $0x4eaf94f4             // mla v20.4s, v7.4s,  v15.4s
	WORD $0x4eaf9515             // mla v21.4s, v8.4s,  v15.4s

	// ── Arithmetic shift right by 21 ──────────────────────────────────────
	WORD $0x4f2b0610             // sshr v16.4s, v16.4s, #21
	WORD $0x4f2b0631             // sshr v17.4s, v17.4s, #21
	WORD $0x4f2b0652             // sshr v18.4s, v18.4s, #21
	WORD $0x4f2b0673             // sshr v19.4s, v19.4s, #21
	WORD $0x4f2b0694             // sshr v20.4s, v20.4s, #21
	WORD $0x4f2b06b5             // sshr v21.4s, v21.4s, #21

	// ── Narrow int32 → int16 with signed saturation ───────────────────────
	WORD $0x0e614a19             // sqxtn  v25.4h, v16.4s   B lo
	WORD $0x4e614a39             // sqxtn2 v25.8h, v17.4s   B hi
	WORD $0x0e614a5a             // sqxtn  v26.4h, v18.4s   G lo
	WORD $0x4e614a7a             // sqxtn2 v26.8h, v19.4s   G hi
	WORD $0x0e614a9b             // sqxtn  v27.4h, v20.4s   R lo
	WORD $0x4e614abb             // sqxtn2 v27.8h, v21.4s   R hi

	// ── Narrow int16 → uint8, clamping to [0, 255] ────────────────────────
	WORD $0x2e212b39             // sqxtun v25.8b, v25.8h   B
	WORD $0x2e212b5a             // sqxtun v26.8b, v26.8h   G
	WORD $0x2e212b7b             // sqxtun v27.8b, v27.8h   R

	// ── Store 8 BGRA pixels interleaved, advance dst by 32 ────────────────
	WORD $0x0c9f0079             // st4 {v25.8b, v26.8b, v27.8b, v28.8b}, [x3], #32

	SUBS $1, R4, R4
	BNE loop

done:
	RET
