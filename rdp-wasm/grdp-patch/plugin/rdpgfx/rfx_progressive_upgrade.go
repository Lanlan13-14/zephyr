package rdpgfx

import (
	"encoding/binary"
	"log/slog"
	"sync"
)

// rfxBitReader is a big-endian bit reader used for the SRL and RAW streams in
// RFX Progressive TILE_UPGRADE. The first bit of each byte is the most
// significant bit (matching FreeRDP wBitStream behaviour on MSB-first
// platforms).
type rfxBitReader struct {
	data   []byte
	bitPos int
	failed bool
}

func (b *rfxBitReader) readBits(n int) uint16 {
	if n <= 0 {
		return 0
	}
	if b.failed || b.bitPos+n > len(b.data)*8 {
		b.failed = true
		return 0
	}
	var val uint16
	for i := 0; i < n; i++ {
		byteIdx := b.bitPos >> 3
		bitIdx := 7 - (b.bitPos & 7)
		val = (val << 1) | uint16((b.data[byteIdx]>>bitIdx)&1)
		b.bitPos++
	}
	return val
}

func (b *rfxBitReader) skipToByteBoundary() {
	if b.failed {
		return
	}
	if rem := b.bitPos & 7; rem != 0 {
		b.bitPos += 8 - rem
		if b.bitPos > len(b.data)*8 {
			b.failed = true
		}
	}
}

func (b *rfxBitReader) remainingBits() int {
	if b.bitPos >= len(b.data)*8 {
		return 0
	}
	return len(b.data)*8 - b.bitPos
}

// rfxSrlState holds the SRL decoder state for one component during upgrade.
type rfxSrlState struct {
	srl   *rfxBitReader
	raw   *rfxBitReader
	nz    int
	kp    int
	mode  bool
	nonLL bool
}

func newRfxSrlState(srl, raw []byte) *rfxSrlState {
	return &rfxSrlState{
		srl:  &rfxBitReader{data: srl},
		raw:  &rfxBitReader{data: raw},
		kp:   8,
		mode: false,
	}
}

// rfxSrlRead decodes one signed coefficient from the SRL bit-plane stream.
// It matches FreeRDP progressive_rfx_srl_read.
func rfxSrlRead(state *rfxSrlState, numBits int) int16 {
	if state.srl.failed {
		return 0
	}
	if state.nz > 0 {
		state.nz--
		return 0
	}

	k := state.kp / 8

	if !state.mode {
		// zero encoding
		bit := state.srl.readBits(1)
		if bit == 0 {
			// '0' bit: nz >= (1 << k), nz = (1 << k); consume one for the
			// current zero coefficient. Matches FreeRDP
			// progressive_rfx_srl_read: nz = (1 << k); kp += 4; nz--.
			state.nz = 1 << k
			state.kp += 4
			if state.kp > 80 {
				state.kp = 80
			}
			state.nz--
			return 0
		}
		// '1' bit: nz < 2^k, read next k bits
		state.nz = 0
		state.mode = true
		if k > 0 {
			state.nz = int(state.srl.readBits(k))
			if state.srl.failed {
				return 0
			}
		}
		if state.nz > 0 {
			state.nz--
			return 0
		}
	}

	state.mode = false
	sign := state.srl.readBits(1)
	if state.srl.failed {
		return 0
	}
	if state.kp < 6 {
		state.kp = 0
	} else {
		state.kp -= 6
	}

	if numBits == 1 {
		if sign != 0 {
			return -1
		}
		return 1
	}

	maxVal := (1 << numBits) - 1
	mag := 1
	for mag < maxVal {
		bit := state.srl.readBits(1)
		if state.srl.failed {
			return 0
		}
		if bit != 0 {
			break
		}
		mag++
	}
	if mag > 32767 {
		mag = 32767
	}
	if sign != 0 {
		return int16(-mag)
	}
	return int16(mag)
}

// rfxRawShift reads a numBits unsigned value from the RAW stream and returns
// it as a signed int16.
func rfxRawShift(raw *rfxBitReader, numBits int) int16 {
	v := raw.readBits(numBits)
	return int16(v)
}

// rfxUpgradeBlock applies SRL + RAW bit-plane upgrade to one subband.
// nonLL: if true, sign information is used to select SRL vs RAW. For LL3
// the sign is ignored and RAW is always used.
func rfxUpgradeBlock(state *rfxSrlState, current, sign []int16, length int, shift, numBits uint8) {
	if numBits < 1 || length <= 0 {
		return
	}
	if length > len(current) {
		length = len(current)
	}
	if length > len(sign) {
		length = len(sign)
	}
	s := int(shift)
	if state.nonLL {
		for i := 0; i < length; i++ {
			var input int16
			signVal := sign[i]
			if signVal > 0 {
				input = rfxRawShift(state.raw, int(numBits))
			} else if signVal < 0 {
				input = -rfxRawShift(state.raw, int(numBits))
			} else {
				input = rfxSrlRead(state, int(numBits))
				if !state.srl.failed {
					sign[i] = input
				}
			}
			if state.raw.failed || state.srl.failed {
				return
			}
			// Accumulate in int32 like FreeRDP's WINPR_ASSERTING_INT_CAST,
			// then narrow once to int16 (wrap on overflow).
			current[i] = int16(int32(current[i]) + (int32(input) << s))
		}
	} else {
		for i := 0; i < length; i++ {
			input := rfxRawShift(state.raw, int(numBits))
			if state.raw.failed {
				return
			}
			current[i] = int16(int32(current[i]) + (int32(input) << s))
		}
	}
}

// rfxUpgradeComponentExtrapolate upgrades one component assuming the
// extrapolate frequency-domain layout used by FreeRDP.
//
// Band layout (same as rfxDequantizeExtrapolate):
//
//	HL1 1023 @0, LH1 1023 @1023, HH1 961 @2046,
//	HL2 272 @3007, LH2 272 @3279, HH2 256 @3551,
//	HL3 72 @3807, LH3 72 @3879, HH3 64 @3951, LL3 81 @4015
func rfxUpgradeComponentExtrapolate(current, sign []int16, shift, bitPos, numBits rfxQuant, srlData, rawData []byte) bool {
	state := newRfxSrlState(srlData, rawData)
	state.nonLL = true
	rfxUpgradeBlock(state, current[0:1023], sign[0:1023], 1023, shift.HL1, numBits.HL1)
	rfxUpgradeBlock(state, current[1023:2046], sign[1023:2046], 1023, shift.LH1, numBits.LH1)
	rfxUpgradeBlock(state, current[2046:3007], sign[2046:3007], 961, shift.HH1, numBits.HH1)
	rfxUpgradeBlock(state, current[3007:3279], sign[3007:3279], 272, shift.HL2, numBits.HL2)
	rfxUpgradeBlock(state, current[3279:3551], sign[3279:3551], 272, shift.LH2, numBits.LH2)
	rfxUpgradeBlock(state, current[3551:3807], sign[3551:3807], 256, shift.HH2, numBits.HH2)
	rfxUpgradeBlock(state, current[3807:3879], sign[3807:3879], 72, shift.HL3, numBits.HL3)
	rfxUpgradeBlock(state, current[3879:3951], sign[3879:3951], 72, shift.LH3, numBits.LH3)
	rfxUpgradeBlock(state, current[3951:4015], sign[3951:4015], 64, shift.HH3, numBits.HH3)
	state.nonLL = false
	rfxUpgradeBlock(state, current[4015:4096], sign[4015:4096], 81, shift.LL3, numBits.LL3)
	return !state.srl.failed && !state.raw.failed
}

// rfxUpgradeComponent upgrades one component. Unlike the first-pass decode,
// FreeRDP's progressive_rfx_upgrade_component uses a SINGLE band layout for
// upgrade — the extrapolate layout (HL1 1023 @0 … LL3 81 @4015) — regardless
// of the region's RFX_DWT_REDUCE_EXTRAPOLATE flag. The first-pass stores
// coefficients in whatever layout its own flag implied; however FreeRDP's
// upgrade path always indexes the extrapolate layout, so we mirror that here
// and ignore the extrapolate flag for band placement.
func rfxUpgradeComponent(current, sign []int16, shift, bitPos, numBits rfxQuant, srlData, rawData []byte, extrapolate bool) bool {
	_ = bitPos
	_ = extrapolate // FreeRDP upgrade uses one (extrapolate) layout unconditionally.
	return rfxUpgradeComponentExtrapolate(current, sign, shift, bitPos, numBits, srlData, rawData)
}

// quantSub subtracts b from a component-wise. If any band would underflow the
// result is clamped to zero and ok is set to false.
func quantSub(a, b rfxQuant) (rfxQuant, bool) {
	ok := true
	sub := func(v1, v2 uint8) uint8 {
		if v1 < v2 {
			ok = false
			return 0
		}
		return v1 - v2
	}
	return rfxQuant{
		LL3: sub(a.LL3, b.LL3), HL3: sub(a.HL3, b.HL3), LH3: sub(a.LH3, b.LH3), HH3: sub(a.HH3, b.HH3),
		HL2: sub(a.HL2, b.HL2), LH2: sub(a.LH2, b.LH2), HH2: sub(a.HH2, b.HH2),
		HL1: sub(a.HL1, b.HL1), LH1: sub(a.LH1, b.LH1), HH1: sub(a.HH1, b.HH1),
	}, ok
}

// decodeTileUpgrade handles PROGRESSIVE_WBT_TILE_UPGRADE (0xCCC7).
// It upgrades the cached frequency-domain coefficients for a tile using SRL
// and RAW bit-plane data, then re-runs inverse DWT and places the tile.
func (d *rfxProgressiveDecoder) decodeTileUpgrade(data []byte, quants []rfxQuant, prog []progressiveQuant, output []byte, outW, outH int, extrapolate, subbandDiff, parallelComponents bool) {
	if len(data) < 20 {
		return
	}
	quantIdxY, quantIdxCb, quantIdxCr := data[0], data[1], data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	quality := data[7]
	ySrlLen := int(binary.LittleEndian.Uint16(data[8:]))
	yRawLen := int(binary.LittleEndian.Uint16(data[10:]))
	cbSrlLen := int(binary.LittleEndian.Uint16(data[12:]))
	cbRawLen := int(binary.LittleEndian.Uint16(data[14:]))
	crSrlLen := int(binary.LittleEndian.Uint16(data[16:]))
	crRawLen := int(binary.LittleEndian.Uint16(data[18:]))

	if ySrlLen < 0 || yRawLen < 0 || cbSrlLen < 0 || cbRawLen < 0 || crSrlLen < 0 || crRawLen < 0 {
		return
	}

	off := 20
	ySrlData := safeSlice(data, off, ySrlLen)
	off += ySrlLen
	yRawData := safeSlice(data, off, yRawLen)
	off += yRawLen
	cbSrlData := safeSlice(data, off, cbSrlLen)
	off += cbSrlLen
	cbRawData := safeSlice(data, off, cbRawLen)
	off += cbRawLen
	crSrlData := safeSlice(data, off, crSrlLen)
	off += crSrlLen
	crRawData := safeSlice(data, off, crRawLen)

	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
	d.mu.Lock()
	cached := d.tileCache[tileKey]
	if cached == nil || cached.y == nil || cached.cb == nil || cached.cr == nil {
		d.mu.Unlock()
		slog.Warn("RFX progressive: TILE_UPGRADE missing cache", "x", xIdx, "y", yIdx)
		return
	}

	qY := rfxGetQuant(quants, int(quantIdxY))
	qCb := rfxGetQuant(quants, int(quantIdxCb))
	qCr := rfxGetQuant(quants, int(quantIdxCr))
	pqY, pqCb, pqCr := progQuantForQuality(prog, quality)

	newYBit := quantAdd(qY, pqY)
	newCbBit := quantAdd(qCb, pqCb)
	newCrBit := quantAdd(qCr, pqCr)

	_, okY := quantSub(cached.yBit, newYBit)
	_, okCb := quantSub(cached.cbBit, newCbBit)
	_, okCr := quantSub(cached.crBit, newCrBit)
	if !okY || !okCb || !okCr {
		d.mu.Unlock()
		slog.Warn("RFX progressive: TILE_UPGRADE invalid bitPos delta", "x", xIdx, "y", yIdx)
		return
	}

	shiftY, okYs := quantLSub(newYBit, 1)
	shiftCb, okCbs := quantLSub(newCbBit, 1)
	shiftCr, okCrs := quantLSub(newCrBit, 1)
	if !okYs || !okCbs || !okCrs {
		d.mu.Unlock()
		slog.Warn("RFX progressive: TILE_UPGRADE shift underflow", "x", xIdx, "y", yIdx)
		return
	}

	if cached.ySign == nil || cached.cbSign == nil || cached.crSign == nil {
		d.mu.Unlock()
		slog.Warn("RFX progressive: TILE_UPGRADE missing sign cache", "x", xIdx, "y", yIdx)
		return
	}

	// Decode into snapshots. current/sign and bit positions are persistent
	// reference state for later upgrades, so a truncated stream must reject the
	// whole tile instead of committing a component prefix.
	nextY, nextCb, nextCr := *cached.y, *cached.cb, *cached.cr
	nextYSign, nextCbSign, nextCrSign := *cached.ySign, *cached.cbSign, *cached.crSign
	upgradeOne := func(current, sign *coeffArr, oldBit, newBit, shift rfxQuant, srlData, rawData []byte) bool {
		numBits, ok := quantSub(oldBit, newBit)
		if !ok {
			return false
		}
		return rfxUpgradeComponent((*current)[:], (*sign)[:], shift, newBit, numBits, srlData, rawData, extrapolate)
	}

	var decodeY, decodeCb, decodeCr bool
	if parallelComponents {
		var wg sync.WaitGroup
		wg.Go(func() { decodeY = upgradeOne(&nextY, &nextYSign, cached.yBit, newYBit, shiftY, ySrlData, yRawData) })
		wg.Go(func() {
			decodeCb = upgradeOne(&nextCb, &nextCbSign, cached.cbBit, newCbBit, shiftCb, cbSrlData, cbRawData)
		})
		wg.Go(func() {
			decodeCr = upgradeOne(&nextCr, &nextCrSign, cached.crBit, newCrBit, shiftCr, crSrlData, crRawData)
		})
		wg.Wait()
	} else {
		decodeY = upgradeOne(&nextY, &nextYSign, cached.yBit, newYBit, shiftY, ySrlData, yRawData)
		decodeCb = upgradeOne(&nextCb, &nextCbSign, cached.cbBit, newCbBit, shiftCb, cbSrlData, cbRawData)
		decodeCr = upgradeOne(&nextCr, &nextCrSign, cached.crBit, newCrBit, shiftCr, crSrlData, crRawData)
	}
	if !decodeY || !decodeCb || !decodeCr {
		d.mu.Unlock()
		slog.Warn("RFX progressive: TILE_UPGRADE truncated bitstream", "x", xIdx, "y", yIdx,
			"yOK", decodeY, "cbOK", decodeCb, "crOK", decodeCr)
		return
	}

	*cached.y, *cached.cb, *cached.cr = nextY, nextCb, nextCr
	*cached.ySign, *cached.cbSign, *cached.crSign = nextYSign, nextCbSign, nextCrSign
	cached.yBit, cached.cbBit, cached.crBit = newYBit, newCbBit, newCrBit
	d.mu.Unlock()

	yPixels := rfxProcessCachedCurrent(cached.y, extrapolate)
	cbPixels := rfxProcessCachedCurrent(cached.cb, extrapolate)
	crPixels := rfxProcessCachedCurrent(cached.cr, extrapolate)
	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)
	coeffPool.Put((*coeffArr)(yPixels))
	coeffPool.Put((*coeffArr)(cbPixels))
	coeffPool.Put((*coeffArr)(crPixels))
	_ = subbandDiff
	_ = parallelComponents
}
