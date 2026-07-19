package rdpgfx

// RFX Progressive Codec decoder (MS-RDPRFX / MS-RDPEGFX 2.2.4).
// Handles RDPGFX_CODECID_CAPROGRESSIVE (0x0009) in WIRE_TO_SURFACE_PDU_2.
//
// Ported against FreeRDP libfreerdp/codec/progressive.c. It implements the
// RDPEGFX quant order, progressive quant ladders, both inverse-DWT layouts,
// persistent current/sign caches, and SRL+RAW TILE_UPGRADE state transitions.

import (
	"encoding/binary"
	"log/slog"
	"runtime"
	"sync"
)

// Progressive block types (different from non-progressive WBT_* at same values!)
const (
	progWBTSync        = 0xCCC0
	progWBTFrameBegin  = 0xCCC1
	progWBTFrameEnd    = 0xCCC2
	progWBTContext     = 0xCCC3
	progWBTRegion      = 0xCCC4
	progWBTTileSimple  = 0xCCC5
	progWBTTileFirst   = 0xCCC6
	progWBTTileUpgrade = 0xCCC7

	rfxDWTReduceExtrapolate = 0x01
	rfxTileDifference       = 0x01
	rfxSubbandDiffing       = 0x01
)

const rfxTileSize = 64

// rfxQuant holds the 10 quantization values for one component (5 bytes, 10 nibbles).
// Field order matches FreeRDP RFX_COMPONENT_CODEC_QUANT names.
type rfxQuant struct {
	LL3, HL3, LH3, HH3 uint8
	HL2, LH2, HH2      uint8
	HL1, LH1, HH1      uint8
}

// progressiveQuant is one RFX_PROGRESSIVE_CODEC_QUANT entry (16 bytes).
type progressiveQuant struct {
	quality   uint8
	y, cb, cr rfxQuant
}

// rfxTileCoeffs stores FreeRDP's progressive tile state: each component's
// `current` coefficients after differential decode/dequantization and before
// inverse DWT, plus the post-RLGR sign planes and progressive bit positions.
// TILE_UPGRADE must add SRL/RAW values in this exact current-coefficient domain.
type rfxTileCoeffs struct {
	y  *coeffArr
	cb *coeffArr
	cr *coeffArr
	// sign arrays (for upgrade path); nil until first pass
	ySign, cbSign, crSign *coeffArr
	// progressive bit positions after last pass
	yBit, cbBit, crBit rfxQuant
	// base quant used
	yQ, cbQ, crQ rfxQuant
}

type rfxProgTileWork struct {
	tileType uint16
	data     []byte
}

type rfxProgressiveDecoder struct {
	mu        sync.RWMutex
	tileCache map[uint32]*rfxTileCoeffs // key: yIdx<<16 | xIdx
	// context flags from last PROGRESSIVE_WBT_CONTEXT (RFX_SUBBAND_DIFFING etc.)
	contextFlags  uint8
	rectsBuf      []rfxRect
	quantsBuf     []rfxQuant
	progQuantsBuf []progressiveQuant
	tilesBuf      []rfxProgTileWork
}

func newRfxProgressiveDecoder() *rfxProgressiveDecoder {
	return &rfxProgressiveDecoder{
		tileCache: make(map[uint32]*rfxTileCoeffs),
	}
}

// Reset discards the tile coefficient cache. Call this whenever the server
// starts a new progressive sequence (e.g. on RESET_GRAPHICS).
func (d *rfxProgressiveDecoder) Reset() {
	d.mu.Lock()
	old := d.tileCache
	d.tileCache = make(map[uint32]*rfxTileCoeffs)
	d.contextFlags = 0
	d.mu.Unlock()
	for _, tc := range old {
		freeTileCoeffs(tc)
	}
}

func freeTileCoeffs(tc *rfxTileCoeffs) {
	if tc == nil {
		return
	}
	for _, a := range []*coeffArr{tc.y, tc.cb, tc.cr, tc.ySign, tc.cbSign, tc.crSign} {
		if a != nil {
			coeffPool.Put(a)
		}
	}
}

// rfxRect represents a rectangle of decoded tiles.
type rfxRect struct {
	x, y, w, h int
}

// Decode processes RFX Progressive codec data, rendering tiles onto the
// provided surface buffer. Returns the bounding rectangles of decoded regions.
func (d *rfxProgressiveDecoder) Decode(data []byte, surfData []byte, width, height int) []rfxRect {
	var rects []rfxRect

	offset := 0
	for offset+6 <= len(data) {
		blockType := binary.LittleEndian.Uint16(data[offset:])
		blockLen := binary.LittleEndian.Uint32(data[offset+2:])

		if blockLen < 6 || offset+int(blockLen) > len(data) {
			break
		}

		blockData := data[offset+6 : offset+int(blockLen)]

		switch blockType {
		case progWBTSync, progWBTFrameBegin, progWBTFrameEnd:
		// no-op
		case progWBTContext:
			// PROGRESSIVE_BLOCK_CONTEXT is ctxId(1), tileSize(2 LE),
			// flags(1). FreeRDP reads the flags from byte 3.
			if len(blockData) >= 4 {
				d.contextFlags = blockData[3]
			} else {
				slog.Warn("RFX progressive: short CONTEXT block", "length", len(blockData))
			}
		case progWBTRegion:
			regionRects, _ := d.parseRegion(blockData, surfData, width, height)
			rects = append(rects, regionRects...)
		default:
			slog.Debug("RFX: unknown progressive block type", "type", blockType)
		}

		offset += int(blockLen)
	}

	return rects
}

// parseRegion extracts rects and quant tables from a PROGRESSIVE_WBT_REGION block,
// and decodes the tile sub-blocks embedded within it onto the surface.
func (d *rfxProgressiveDecoder) parseRegion(data []byte, surfData []byte, outW, outH int) ([]rfxRect, []rfxQuant) {
	if len(data) < 12 {
		return nil, nil
	}

	// tileSize := data[0]
	numRects := binary.LittleEndian.Uint16(data[1:])
	numQuant := data[3]
	numProgQuant := data[4]
	flags := data[5]
	numTiles := binary.LittleEndian.Uint16(data[6:])
	// tileDataSize := binary.LittleEndian.Uint32(data[8:])

	offset := 12

	if cap(d.rectsBuf) >= int(numRects) {
		d.rectsBuf = d.rectsBuf[:numRects]
	} else {
		d.rectsBuf = make([]rfxRect, numRects)
	}
	rects := d.rectsBuf
	for i := range numRects {
		if offset+8 > len(data) {
			return nil, nil
		}
		rx := int(binary.LittleEndian.Uint16(data[offset:]))
		ry := int(binary.LittleEndian.Uint16(data[offset+2:]))
		rw := int(binary.LittleEndian.Uint16(data[offset+4:]))
		rh := int(binary.LittleEndian.Uint16(data[offset+6:]))
		rects[i] = rfxRect{x: rx, y: ry, w: rw, h: rh}
		offset += 8
	}

	if cap(d.quantsBuf) >= int(numQuant) {
		d.quantsBuf = d.quantsBuf[:numQuant]
	} else {
		d.quantsBuf = make([]rfxQuant, numQuant)
	}
	quants := d.quantsBuf
	for i := range numQuant {
		if offset+5 > len(data) {
			return nil, nil
		}
		quants[i] = parseRfxQuantGFX(data[offset:])
		offset += 5
	}

	if cap(d.progQuantsBuf) >= int(numProgQuant) {
		d.progQuantsBuf = d.progQuantsBuf[:numProgQuant]
	} else {
		d.progQuantsBuf = make([]progressiveQuant, numProgQuant)
	}
	progQuants := d.progQuantsBuf
	for i := range numProgQuant {
		if offset+16 > len(data) {
			return nil, nil
		}
		progQuants[i].quality = data[offset]
		progQuants[i].y = parseRfxQuantGFX(data[offset+1:])
		progQuants[i].cb = parseRfxQuantGFX(data[offset+6:])
		progQuants[i].cr = parseRfxQuantGFX(data[offset+11:])
		offset += 16
	}

	if cap(d.tilesBuf) >= int(numTiles) {
		d.tilesBuf = d.tilesBuf[:0]
	} else {
		d.tilesBuf = make([]rfxProgTileWork, 0, numTiles)
	}
	tiles := d.tilesBuf
	for offset+6 <= len(data) {
		tileType := binary.LittleEndian.Uint16(data[offset:])
		tileLen := binary.LittleEndian.Uint32(data[offset+2:])
		if tileLen < 6 || offset+int(tileLen) > len(data) {
			break
		}
		switch tileType {
		case progWBTTileSimple, progWBTTileFirst, progWBTTileUpgrade:
			tiles = append(tiles, rfxProgTileWork{tileType: tileType, data: data[offset+6 : offset+int(tileLen)]})
		default:
			slog.Debug("RFX: unknown progressive tile type", "type", tileType)
		}
		offset += int(tileLen)
	}
	d.tilesBuf = tiles

	extrapolate := flags&rfxDWTReduceExtrapolate != 0
	subbandDiff := d.contextFlags&rfxSubbandDiffing != 0

	const parallelTileThreshold = 12
	decodeTile := func(tw rfxProgTileWork, parallel bool) {
		switch tw.tileType {
		case progWBTTileSimple:
			d.decodeTileSimple(tw.data, quants, progQuants, surfData, outW, outH, extrapolate, subbandDiff, parallel)
		case progWBTTileFirst:
			d.decodeTileFirst(tw.data, quants, progQuants, surfData, outW, outH, extrapolate, subbandDiff, parallel)
		case progWBTTileUpgrade:
			d.decodeTileUpgrade(tw.data, quants, progQuants, surfData, outW, outH, extrapolate, subbandDiff, parallel)
		}
	}
	if len(tiles) >= parallelTileThreshold {
		workers := min(runtime.NumCPU(), len(tiles))
		ch := make(chan rfxProgTileWork, len(tiles))
		for _, tw := range tiles {
			ch <- tw
		}
		close(ch)
		var wg sync.WaitGroup
		for range workers {
			wg.Go(func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("RFX progressive: tile decode panic", "err", r)
					}
				}()
				for tw := range ch {
					decodeTile(tw, false)
				}
			})
		}
		wg.Wait()
	} else {
		for _, tw := range tiles {
			decodeTile(tw, true)
		}
	}

	return rects, quants
}

// parseRfxQuantGFX reads RDPEGFX progressive quant nibble order
// (FreeRDP progressive_component_codec_quant_read):
//
//	LL3/HL3, LH3/HH3, HL2/LH2, HH2/HL1, LH1/HH1
func parseRfxQuantGFX(data []byte) rfxQuant {
	return rfxQuant{
		LL3: data[0] & 0x0F,
		HL3: data[0] >> 4,
		LH3: data[1] & 0x0F,
		HH3: data[1] >> 4,
		HL2: data[2] & 0x0F,
		LH2: data[2] >> 4,
		HH2: data[3] & 0x0F,
		HL1: data[3] >> 4,
		LH1: data[4] & 0x0F,
		HH1: data[4] >> 4,
	}
}

// parseRfxQuant reads non-progressive RDPRFX quant nibble order
// (TS_RFX_CODEC_QUANT / FreeRDP note in rfx.c):
//
//	LL3/LH3, HL3/HH3, LH2/HL2, HH2/LH1, HL1/HH1
func parseRfxQuant(data []byte) rfxQuant {
	// FreeRDP's Progressive decoder uses the same byte order as the RFX
	// progressive_component_codec_quant_read routine: LL3/HL3,
	// LH3/HH3, HL2/LH2, HH2/HL1, LH1/HH1.
	return rfxQuant{
		LL3: data[0] & 0x0F,
		HL3: data[0] >> 4,
		LH3: data[1] & 0x0F,
		HH3: data[1] >> 4,
		HL2: data[2] & 0x0F,
		LH2: data[2] >> 4,
		HH2: data[3] & 0x0F,
		HL1: data[3] >> 4,
		LH1: data[4] & 0x0F,
		HH1: data[4] >> 4,
	}
}

// rfxDecodeComponent is the non-progressive CAVIDEO path (MS-RDPRFX).
// Progressive uses rfxDecodeComponentProgressive instead.
func rfxDecodeComponent(data []byte, quant rfxQuant, rlgrMode int) []int16 {
	const tilePixels = rfxTileSize * rfxTileSize
	arr := coeffPool.Get().(*coeffArr)
	coeffs := arr[:]
	if data == nil {
		clear(coeffs)
		return coeffs
	}
	if rlgrMode == 3 {
		coeffs = rlgr3Decode(data, tilePixels, coeffs)
	} else {
		coeffs = rlgr1Decode(data, tilePixels, coeffs)
	}
	// Non-progressive FreeRDP uses fused differential+shift on LL3 when LL3>1.
	if quant.LL3 > 1 {
		shift := quant.LL3 - 1
		coeffs[4032] <<= shift
		for i := 4033; i < 4096; i++ {
			coeffs[i] = coeffs[i-1] + coeffs[i]<<shift
		}
	} else {
		for i := 4033; i < 4096; i++ {
			coeffs[i] += coeffs[i-1]
		}
	}
	// Dequantize remaining bands with factor-1 (non-progressive convention).
	rfxShiftSubbandNP(coeffs[0:1024], quant.HL1)
	rfxShiftSubbandNP(coeffs[1024:2048], quant.LH1)
	rfxShiftSubbandNP(coeffs[2048:3072], quant.HH1)
	rfxShiftSubbandNP(coeffs[3072:3328], quant.HL2)
	rfxShiftSubbandNP(coeffs[3328:3584], quant.LH2)
	rfxShiftSubbandNP(coeffs[3584:3840], quant.HH2)
	rfxShiftSubbandNP(coeffs[3840:3904], quant.HL3)
	rfxShiftSubbandNP(coeffs[3904:3968], quant.LH3)
	rfxShiftSubbandNP(coeffs[3968:4032], quant.HH3)
	rfxInverseDWT2D(coeffs)
	return coeffs
}

// Non-progressive shift: FreeRDP uses (factor-1) when factor>1.
func rfxShiftSubbandNP(data []int16, factor uint8) {
	if factor <= 1 {
		return
	}
	shift := factor - 1
	for i := range data {
		data[i] <<= shift
	}
}

func quantAdd(a, b rfxQuant) rfxQuant {
	return rfxQuant{
		LL3: a.LL3 + b.LL3, HL3: a.HL3 + b.HL3, LH3: a.LH3 + b.LH3, HH3: a.HH3 + b.HH3,
		HL2: a.HL2 + b.HL2, LH2: a.LH2 + b.LH2, HH2: a.HH2 + b.HH2,
		HL1: a.HL1 + b.HL1, LH1: a.LH1 + b.LH1, HH1: a.HH1 + b.HH1,
	}
}

// quantLSub subtracts val from every band (FreeRDP progressive_rfx_quant_lsub).
// Returns ok=false if any band would underflow (FreeRDP returns FALSE there).
func quantLSub(q rfxQuant, val uint8) (rfxQuant, bool) {
	ok := true
	sub := func(v uint8) uint8 {
		if v < val {
			ok = false
			return 0
		}
		return v - val
	}
	return rfxQuant{
		LL3: sub(q.LL3), HL3: sub(q.HL3), LH3: sub(q.LH3), HH3: sub(q.HH3),
		HL2: sub(q.HL2), LH2: sub(q.LH2), HH2: sub(q.HH2),
		HL1: sub(q.HL1), LH1: sub(q.LH1), HH1: sub(q.HH1),
	}, ok
}

func progQuantForQuality(prog []progressiveQuant, quality uint8) (rfxQuant, rfxQuant, rfxQuant) {
	// rfxProgressiveDecoder uses the RDPGFX current domain for TILE_UPGRADE.
	// The initial pass is always a full-quality decode when quality=0xFF;
	// otherwise the quality field is an index into this region's table.
	if quality == 0xFF {
		return rfxQuant{}, rfxQuant{}, rfxQuant{}
	}
	if int(quality) < len(prog) {
		pq := prog[quality]
		return pq.y, pq.cb, pq.cr
	}
	// Fallback: first table if present, else zeros.
	if len(prog) > 0 {
		return prog[0].y, prog[0].cb, prog[0].cr
	}
	return rfxQuant{}, rfxQuant{}, rfxQuant{}
}

func rfxGetQuant(quants []rfxQuant, idx int) rfxQuant {
	if idx < len(quants) {
		return quants[idx]
	}
	return rfxQuant{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}
}

func safeSlice(data []byte, offset, length int) []byte {
	if length <= 0 || offset < 0 || offset+length > len(data) {
		return nil
	}
	return data[offset : offset+length]
}

// decodeTileSimple handles PROGRESSIVE_WBT_TILE_SIMPLE (0xCCC5) — no quality byte.
func (d *rfxProgressiveDecoder) decodeTileSimple(data []byte, quants []rfxQuant, prog []progressiveQuant, output []byte, outW, outH int, extrapolate, subbandDiff, parallelComponents bool) {
	if len(data) < 16 {
		return
	}
	quantIdxY, quantIdxCb, quantIdxCr := data[0], data[1], data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	flags := data[7]
	yLen := binary.LittleEndian.Uint16(data[8:])
	cbLen := binary.LittleEndian.Uint16(data[10:])
	crLen := binary.LittleEndian.Uint16(data[12:])
	// tailLen := binary.LittleEndian.Uint16(data[14:])

	off := 16
	yData := safeSlice(data, off, int(yLen))
	off += int(yLen)
	cbData := safeSlice(data, off, int(cbLen))
	off += int(cbLen)
	crData := safeSlice(data, off, int(crLen))

	// SIMPLE uses quality 0xFF (full) per FreeRDP progressive_tile_read(simple=true)
	d.decodeTileFirstBody(quantIdxY, quantIdxCb, quantIdxCr, xIdx, yIdx, flags, 0xFF,
		yData, cbData, crData, quants, prog, output, outW, outH, extrapolate, subbandDiff, parallelComponents)
}

// decodeTileFirst handles PROGRESSIVE_WBT_TILE_FIRST (0xCCC6).
func (d *rfxProgressiveDecoder) decodeTileFirst(data []byte, quants []rfxQuant, prog []progressiveQuant, output []byte, outW, outH int, extrapolate, subbandDiff, parallelComponents bool) {
	if len(data) < 17 {
		return
	}
	quantIdxY, quantIdxCb, quantIdxCr := data[0], data[1], data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	flags := data[7]
	quality := data[8]
	yLen := binary.LittleEndian.Uint16(data[9:])
	cbLen := binary.LittleEndian.Uint16(data[11:])
	crLen := binary.LittleEndian.Uint16(data[13:])
	// tailLen := binary.LittleEndian.Uint16(data[15:])

	off := 17
	yData := safeSlice(data, off, int(yLen))
	off += int(yLen)
	cbData := safeSlice(data, off, int(cbLen))
	off += int(cbLen)
	crData := safeSlice(data, off, int(crLen))

	d.decodeTileFirstBody(quantIdxY, quantIdxCb, quantIdxCr, xIdx, yIdx, flags, quality,
		yData, cbData, crData, quants, prog, output, outW, outH, extrapolate, subbandDiff, parallelComponents)
}

func (d *rfxProgressiveDecoder) decodeTileFirstBody(
	quantIdxY, quantIdxCb, quantIdxCr uint8,
	xIdx, yIdx uint16, flags, quality uint8,
	yData, cbData, crData []byte,
	quants []rfxQuant, prog []progressiveQuant,
	output []byte, outW, outH int,
	extrapolate, subbandDiff, parallelComponents bool,
) {
	qY := rfxGetQuant(quants, int(quantIdxY))
	qCb := rfxGetQuant(quants, int(quantIdxCb))
	qCr := rfxGetQuant(quants, int(quantIdxCr))
	pqY, pqCb, pqCr := progQuantForQuality(prog, quality)

	// FreeRDP rejects a quantization underflow instead of silently clamping.
	shiftY, okY := quantLSub(quantAdd(qY, pqY), 1)
	shiftCb, okCb := quantLSub(quantAdd(qCb, pqCb), 1)
	shiftCr, okCr := quantLSub(quantAdd(qCr, pqCr), 1)
	if !okY || !okCb || !okCr {
		slog.Warn("RFX progressive: TILE_FIRST quant underflow", "x", xIdx, "y", yIdx)
		return
	}

	coeffDiff := flags&rfxTileDifference != 0
	_ = subbandDiff // FreeRDP marks it unused in first-pass decode_component

	var yPixels, cbPixels, crPixels []int16
	var newY, newCb, newCr *coeffArr
	var signY, signCb, signCr *coeffArr
	var prevY, prevCb, prevCr *coeffArr
	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
	d.mu.RLock()
	if old := d.tileCache[tileKey]; old != nil {
		prevY, prevCb, prevCr = old.y, old.cb, old.cr
	}
	d.mu.RUnlock()

	decodeOne := func(data []byte, shift rfxQuant, prev *coeffArr) (pix []int16, current, sign *coeffArr) {
		return rfxDecodeComponentProgressive(data, shift, prev, extrapolate, coeffDiff)
	}

	if parallelComponents {
		var wg sync.WaitGroup
		wg.Go(func() { yPixels, newY, signY = decodeOne(yData, shiftY, prevY) })
		wg.Go(func() { cbPixels, newCb, signCb = decodeOne(cbData, shiftCb, prevCb) })
		wg.Go(func() { crPixels, newCr, signCr = decodeOne(crData, shiftCr, prevCr) })
		wg.Wait()
	} else {
		yPixels, newY, signY = decodeOne(yData, shiftY, prevY)
		cbPixels, newCb, signCb = decodeOne(cbData, shiftCb, prevCb)
		crPixels, newCr, signCr = decodeOne(crData, shiftCr, prevCr)
	}

	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)

	d.mu.Lock()
	old := d.tileCache[tileKey]
	d.tileCache[tileKey] = &rfxTileCoeffs{
		y: newY, cb: newCb, cr: newCr,
		ySign: signY, cbSign: signCb, crSign: signCr,
		yBit: quantAdd(qY, pqY), cbBit: quantAdd(qCb, pqCb), crBit: quantAdd(qCr, pqCr),
		yQ: qY, cbQ: qCb, crQ: qCr,
	}
	d.mu.Unlock()
	freeTileCoeffs(old)

	coeffPool.Put((*coeffArr)(yPixels))
	coeffPool.Put((*coeffArr)(cbPixels))
	coeffPool.Put((*coeffArr)(crPixels))
}

// TILE_UPGRADE is implemented in rfx_progressive_upgrade.go.
func rfxProcessCachedCurrent(current *coeffArr, extrapolate bool) []int16 {
	arr := coeffPool.Get().(*coeffArr)
	work := arr[:]
	copy(work, (*current)[:])
	if extrapolate {
		rfxInverseDWT2DExtrapolate(work)
	} else {
		rfxInverseDWT2D(work)
	}
	return work
}

// rfxDecodeComponentProgressive decodes one color component for a progressive
// TILE_FIRST/SIMPLE pass. The returned cached coefficient array is FreeRDP's
// `current` buffer: differential-decoded and dequantized, but before inverse
// DWT. TILE_UPGRADE adds bit-plane data to this same domain.
func rfxDecodeComponentProgressive(data []byte, shift rfxQuant, prevCurrent *coeffArr, extrapolate, coeffDiff bool) (pixels []int16, current, sign *coeffArr) {
	const tilePixels = rfxTileSize * rfxTileSize

	arr := coeffPool.Get().(*coeffArr)
	work := arr[:]
	if data == nil {
		clear(work)
	} else {
		work = rlgr1Decode(data, tilePixels, work)
	}

	// FreeRDP copies sign immediately after RLGR and before coeffDiff/DWT.
	sign = coeffPool.Get().(*coeffArr)
	copy((*sign)[:], work[:tilePixels])

	// Decode the frequency-domain component exactly as progressive.c does.
	if extrapolate {
		rfxDequantizeExtrapolate(work, shift)
		rfxDifferentialDecode(work[4015:4015+81], shift.LL3)
	} else {
		rfxDifferentialDecode(work[4032:4096], shift.LL3)
		rfxDequantizeSkipLL3Prog(work, shift)
	}

	// progressive_rfx_dwt_2d_decode(..., coeffDiff, ..., reverse=false)
	// adds the previous current buffer in-place before it runs the DWT. Go's
	// int16 conversion deliberately mirrors FreeRDP's 16-bit primitive.
	if coeffDiff && prevCurrent != nil {
		for i := 0; i < tilePixels; i++ {
			work[i] = int16(int32(work[i]) + int32(prevCurrent[i]))
		}
	}

	current = coeffPool.Get().(*coeffArr)
	copy((*current)[:], work[:tilePixels])

	if extrapolate {
		rfxInverseDWT2DExtrapolate(work)
	} else {
		rfxInverseDWT2D(work)
	}
	return work, current, sign
}

// rfxDifferentialDecode applies FreeRDP rfx_differential_decode + optional shift.
// FreeRDP does differential first (unshifted), then shift. Our previous code
// fused them incorrectly for progressive (shift-before-cumsum with wrong order).
func rfxDifferentialDecode(band []int16, shift uint8) {
	// FreeRDP performs the cumulative sum in an int32 temporary and stores
	// each result as INT16. The quantization shift is a separate primitive
	// left shift, also modulo 16 bits.
	for i := 1; i < len(band); i++ {
		band[i] = int16(int32(band[i]) + int32(band[i-1]))
	}
	if shift > 0 {
		for i := range band {
			band[i] <<= shift
		}
	}
}

// rfxDequantizeSkipLL3Prog applies progressive shifts (already quant+prog-1)
// to non-LL3 bands in the non-extrapolate layout.
func rfxDequantizeSkipLL3Prog(coeffs []int16, q rfxQuant) {
	rfxShiftSubband(coeffs[0:1024], q.HL1)
	rfxShiftSubband(coeffs[1024:2048], q.LH1)
	rfxShiftSubband(coeffs[2048:3072], q.HH1)
	rfxShiftSubband(coeffs[3072:3328], q.HL2)
	rfxShiftSubband(coeffs[3328:3584], q.LH2)
	rfxShiftSubband(coeffs[3584:3840], q.HH2)
	rfxShiftSubband(coeffs[3840:3904], q.HL3)
	rfxShiftSubband(coeffs[3904:3968], q.LH3)
	rfxShiftSubband(coeffs[3968:4032], q.HH3)
	// LL3 already handled by differential+shift
}

// rfxDequantizeExtrapolate applies FreeRDP extrapolate band layout shifts.
// Band layout (FreeRDP progressive_rfx_decode_component extrapolate=true):
//
//	HL1 1023 @0, LH1 1023 @1023, HH1 961 @2046,
//	HL2 272 @3007, LH2 272 @3279, HH2 256 @3551,
//	HL3 72 @3807, LH3 72 @3879, HH3 64 @3951, LL3 81 @4015
func rfxDequantizeExtrapolate(coeffs []int16, q rfxQuant) {
	rfxShiftSubband(coeffs[0:1023], q.HL1)
	rfxShiftSubband(coeffs[1023:2046], q.LH1)
	rfxShiftSubband(coeffs[2046:3007], q.HH1)
	rfxShiftSubband(coeffs[3007:3279], q.HL2)
	rfxShiftSubband(coeffs[3279:3551], q.LH2)
	rfxShiftSubband(coeffs[3551:3807], q.HH2)
	rfxShiftSubband(coeffs[3807:3879], q.HL3)
	rfxShiftSubband(coeffs[3879:3951], q.LH3)
	rfxShiftSubband(coeffs[3951:4015], q.HH3)
	// LL3@4015 handled by differential+shift separately
}

func rfxShiftSubband(data []int16, factor uint8) {
	if factor == 0 {
		return
	}
	for i := range data {
		data[i] <<= factor
	}
}

// rfxInverseDWT2D performs 3-level inverse 2D DWT in non-extrapolate layout.
// Buffer: [HL1(1024)|LH1(1024)|HH1(1024)|HL2(256)|LH2(256)|HH2(256)|HL3(64)|LH3(64)|HH3(64)|LL3(64)]
func rfxInverseDWT2D(coeffs []int16) {
	bufs := idwtBufPool.Get().(*idwtBufs)
	rfxIDWT2DLevel(coeffs[3840:], bufs.tmp[:256], 8)
	rfxIDWT2DLevel(coeffs[3072:], bufs.tmp[:1024], 16)
	rfxIDWT2DLevel(coeffs[0:], bufs.tmp[:4096], 32)
	idwtBufPool.Put(bufs)
}

// rfxInverseDWT2DExtrapolate mirrors FreeRDP rfx_dwt_2d_extrapolate_decode:
// level3 from offset 3807, level2 from 3007, level1 from 0.
func rfxInverseDWT2DExtrapolate(coeffs []int16) {
	bufs := idwtBufPool.Get().(*idwtBufs)
	// Port of progressive_rfx_dwt_2d_decode_block with FreeRDP band counts.
	progressiveIDWTBlock(coeffs[3807:], bufs.tmp[:], 3)
	progressiveIDWTBlock(coeffs[3007:], bufs.tmp[:], 2)
	progressiveIDWTBlock(coeffs[0:], bufs.tmp[:], 1)
	idwtBufPool.Put(bufs)
}

func progressiveBandLCount(level int) int { return (64 >> level) + 1 }
func progressiveBandHCount(level int) int {
	if level == 1 {
		return (64 >> 1) - 1
	}
	return (64 + (1 << (level - 1))) >> level
}

// progressiveIDWTBlock ports FreeRDP progressive_rfx_dwt_2d_decode_block.
func progressiveIDWTBlock(buffer, temp []int16, level int) {
	nBandL := progressiveBandLCount(level)
	nBandH := progressiveBandHCount(level)
	offset := 0
	HL := buffer[offset : offset+nBandH*nBandL]
	offset += nBandH * nBandL
	LH := buffer[offset : offset+nBandL*nBandH]
	offset += nBandL * nBandH
	HH := buffer[offset : offset+nBandH*nBandH]
	offset += nBandH * nBandH
	LL := buffer[offset : offset+nBandL*nBandL]

	nDstStepX := nBandL + nBandH
	nDstStepY := nBandL + nBandH
	L := temp[0 : nBandL*nDstStepX]
	H := temp[nBandL*nDstStepX : nBandL*nDstStepX+nBandH*nDstStepX]
	LLx := buffer[0 : nDstStepY*nDstStepX]

	progressiveIDWTX(LL, nBandL, HL, nBandH, L, nDstStepX, nBandL, nBandH, nBandL)
	progressiveIDWTX(LH, nBandL, HH, nBandH, H, nDstStepX, nBandL, nBandH, nBandH)
	progressiveIDWTY(L, nDstStepX, H, nDstStepX, LLx, nDstStepY, nBandL, nBandH, nBandL+nBandH)
}

func clampI16(v int32) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}

// progressiveIDWTX ports FreeRDP progressive_rfx_idwt_x.
func progressiveIDWTX(pLow []int16, nLowStep int, pHigh []int16, nHighStep int, pDst []int16, nDstStep, nLowCount, nHighCount, nDstCount int) {
	for i := 0; i < nDstCount; i++ {
		pL := pLow[i*nLowStep:]
		pH := pHigh[i*nHighStep:]
		pX := pDst[i*nDstStep:]
		H0 := int32(pH[0])
		L0 := int32(pL[0])
		X0 := int32(clampI16(L0 - H0))
		X2 := X0
		pLi, pHi := 1, 1
		pXi := 0
		for j := 0; j < nHighCount-1; j++ {
			H1 := int32(pH[pHi])
			pHi++
			L0 = int32(pL[pLi])
			pLi++
			X2 = int32(clampI16(L0 - ((H0 + H1) / 2)))
			X1 := int32(clampI16(((X0 + X2) / 2) + (2 * H0)))
			pX[pXi] = int16(X0)
			pX[pXi+1] = int16(X1)
			pXi += 2
			X0 = X2
			H0 = H1
		}
		if nLowCount <= nHighCount+1 {
			if nLowCount <= nHighCount {
				pX[pXi] = int16(X2)
				pX[pXi+1] = clampI16(X2 + 2*H0)
			} else {
				L0 = int32(pL[pLi])
				X0 = int32(clampI16(L0 - H0))
				pX[pXi] = int16(X2)
				pX[pXi+1] = clampI16(((X0 + X2) / 2) + (2 * H0))
				pX[pXi+2] = int16(X0)
			}
		} else {
			L0 = int32(pL[pLi])
			pLi++
			X0 = int32(clampI16(L0 - (H0 / 2)))
			pX[pXi] = int16(X2)
			pX[pXi+1] = clampI16(((X0 + X2) / 2) + (2 * H0))
			pX[pXi+2] = int16(X0)
			L0 = int32(pL[pLi])
			pX[pXi+3] = clampI16((X0 + L0) / 2)
		}
	}
}

// progressiveIDWTY ports FreeRDP progressive_rfx_idwt_y.
func progressiveIDWTY(pLow []int16, nLowStep int, pHigh []int16, nHighStep int, pDst []int16, nDstStep, nLowCount, nHighCount, nDstCount int) {
	for i := 0; i < nDstCount; i++ {
		pL := pLow[i:]
		pH := pHigh[i:]
		pX := pDst[i:]
		H0 := int32(pH[0])
		L0 := int32(pL[0])
		pLOff, pHOff := nLowStep, nHighStep
		X0 := int32(clampI16(L0 - H0))
		X2 := X0
		pXOff := 0
		for j := 0; j < nHighCount-1; j++ {
			H1 := int32(pH[pHOff])
			pHOff += nHighStep
			L0 = int32(pL[pLOff])
			pLOff += nLowStep
			X2 = int32(clampI16(L0 - ((H0 + H1) / 2)))
			X1 := int32(clampI16(((X0 + X2) / 2) + (2 * H0)))
			pX[pXOff] = int16(X0)
			pXOff += nDstStep
			pX[pXOff] = int16(X1)
			pXOff += nDstStep
			X0 = X2
			H0 = H1
		}
		if nLowCount <= nHighCount+1 {
			if nLowCount <= nHighCount {
				pX[pXOff] = int16(X2)
				pXOff += nDstStep
				pX[pXOff] = clampI16(X2 + 2*H0)
			} else {
				L0 = int32(pL[pLOff])
				X0 = int32(clampI16(L0 - H0))
				pX[pXOff] = int16(X2)
				pXOff += nDstStep
				pX[pXOff] = clampI16(((X0 + X2) / 2) + (2 * H0))
				pXOff += nDstStep
				pX[pXOff] = int16(X0)
			}
		} else {
			L0 = int32(pL[pLOff])
			pLOff += nLowStep
			X0 = int32(clampI16(L0 - (H0 / 2)))
			pX[pXOff] = int16(X2)
			pXOff += nDstStep
			pX[pXOff] = clampI16(((X0 + X2) / 2) + (2 * H0))
			pXOff += nDstStep
			pX[pXOff] = int16(X0)
			pXOff += nDstStep
			L0 = int32(pL[pLOff])
			pX[pXOff] = clampI16((X0 + L0) / 2)
		}
	}
}

// rfxIDWT2DLevel performs one level of inverse 2D DWT (non-extrapolate).
// buf: [HL(n²)|LH(n²)|HH(n²)|LL(n²)] → (2n)×(2n) result in buf.
func rfxIDWT2DLevel(buf, tmp []int16, n int) {
	nn := n * n
	size := 2 * n
	hl := buf[0:nn]
	lh := buf[nn : 2*nn]
	hh := buf[2*nn : 3*nn]
	ll := buf[3*nn : 4*nn]

	// This is a direct port of FreeRDP rfx_dwt_2d_decode_block.
	// Keep every wavelet sample at int16 width, but do each arithmetic
	// expression at int32 width before the narrowing conversion. Narrowing an
	// intermediate half-result before the subtraction is not equivalent to
	// FreeRDP's C expression and corrupts dense tiles.
	for row := 0; row < n; row++ {
		rowOff := row * n
		lDstOff := row * size
		hDstOff := (row + n) * size

		// Horizontal inverse: first produce all even samples, then all odd
		// samples. FreeRDP's odd sample uses the current and next even sample,
		// not the previous even sample.
		tmp[lDstOff] = int16(int32(ll[rowOff]) - ((int32(hl[rowOff])*2 + 1) >> 1))
		tmp[hDstOff] = int16(int32(lh[rowOff]) - ((int32(hh[rowOff])*2 + 1) >> 1))
		for col := 1; col < n; col++ {
			x := col << 1
			tmp[lDstOff+x] = int16(int32(ll[rowOff+col]) - ((int32(hl[rowOff+col-1]) + int32(hl[rowOff+col]) + 1) >> 1))
			tmp[hDstOff+x] = int16(int32(lh[rowOff+col]) - ((int32(hh[rowOff+col-1]) + int32(hh[rowOff+col]) + 1) >> 1))
		}
		for col := 0; col < n-1; col++ {
			x := col << 1
			tmp[lDstOff+x+1] = int16((int32(hl[rowOff+col]) << 1) + ((int32(tmp[lDstOff+x]) + int32(tmp[lDstOff+x+2])) >> 1))
			tmp[hDstOff+x+1] = int16((int32(hh[rowOff+col]) << 1) + ((int32(tmp[hDstOff+x]) + int32(tmp[hDstOff+x+2])) >> 1))
		}
		x := (n - 1) << 1
		tmp[lDstOff+x+1] = int16((int32(hl[rowOff+n-1]) << 1) + int32(tmp[lDstOff+x]))
		tmp[hDstOff+x+1] = int16((int32(hh[rowOff+n-1]) << 1) + int32(tmp[hDstOff+x]))
	}

	for col := 0; col < size; col++ {
		l := col
		h := n*size + col
		dst := col
		buf[dst] = int16(int32(tmp[l]) - ((int32(tmp[h])*2 + 1) >> 1))
		for row := 1; row < n; row++ {
			l += size
			h += size
			dst += 2 * size
			even := int32(tmp[l]) - ((int32(tmp[h-size]) + int32(tmp[h]) + 1) >> 1)
			buf[dst] = int16(even)
			// FreeRDP stores d2 as INT16 before the odd-sample expression
			// reads dst[2*width]. Use the narrowed value from buf[dst], not
			// the wider int32 temporary, or overflowed even samples diverge.
			buf[dst-size] = int16((int32(tmp[h-size]) << 1) + ((int32(buf[dst-2*size]) + int32(buf[dst])) >> 1))
		}
		buf[dst+size] = int16((int32(tmp[h]) << 1) + ((int32(buf[dst]) * 2) >> 1))
	}
}

// rfxPlaceTile converts YCbCr tile to BGRA using tile-grid indices.
func rfxPlaceTile(yCoeffs, cbCoeffs, crCoeffs []int16, xIdx, yIdx int, output []byte, outW, outH int) {
	rfxPlaceTileAbs(yCoeffs, cbCoeffs, crCoeffs, xIdx*rfxTileSize, yIdx*rfxTileSize, output, outW, outH)
}

// rfxPlaceTileAbs converts YCbCr tile to BGRA at absolute pixel coordinates.
func rfxPlaceTileAbs(yCoeffs, cbCoeffs, crCoeffs []int16, tileX, tileY int, output []byte, outW, outH int) {
	tileW := rfxTileSize
	tileH := rfxTileSize
	if tileX+tileW > outW {
		tileW = outW - tileX
	}
	if tileY+tileH > outH {
		tileH = outH - tileY
	}
	if tileW <= 0 || tileH <= 0 {
		return
	}
	for row := 0; row < tileH; row++ {
		dstStart := ((tileY+row)*outW + tileX) * 4
		dstEnd := dstStart + tileW*4
		if dstStart < 0 || dstEnd > len(output) {
			continue
		}
		dstRow := output[dstStart:dstEnd:dstEnd]
		srcOff := row * rfxTileSize
		ictToBGRA(
			yCoeffs[srcOff:srcOff+tileW:srcOff+tileW],
			cbCoeffs[srcOff:srcOff+tileW:srcOff+tileW],
			crCoeffs[srcOff:srcOff+tileW:srcOff+tileW],
			dstRow, tileW,
		)
	}
}
