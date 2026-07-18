package rdpgfx

// RFX Progressive Codec decoder (MS-RDPRFX / MS-RDPEGFX 2.2.4).
// Handles RDPGFX_CODECID_CAPROGRESSIVE (0x0009) in WIRE_TO_SURFACE_PDU_2.
//
// Corrected against FreeRDP libfreerdp/codec/progressive.c for the real
// session capture under /tmp/progressive_live (8 WTS2 frames). Key fixes:
//  1. RDPEGFX quant nibble order is LL3/HL3, LH3/HH3, HL2/LH2, HH2/HL1, LH1/HH1
//     (not the RDPRFX LL3/LH3 order used by non-progressive CAVIDEO).
//  2. RFX_PROGRESSIVE_CODEC_QUANT tables are applied: shift = base + prog - 1.
//  3. RFX_DWT_REDUCE_EXTRAPOLATE (region flags bit 0) uses FreeRDP's
//     extrapolate band sizes / layout / inverse DWT.
//  4. TILE_UPGRADE uses SRL+RAW bitplane upgrade (not fake RLGR deltas).

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

// rfxTileCoeffs holds the raw RLGR-decoded coefficients for one tile (all three
// components), stored before LL3 differential decode and dequantization.
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
			if len(blockData) >= 1 {
				// ctxId := blockData[0]; tileSize := blockData[1] when len>=2
				// FreeRDP stores flags in context; second byte after ctxId/tileSize
				// Layout: ctxId(1) tileSize(1) flags(1) ... — blockLen is 10 → body 4 bytes: 00 40 00 01
				// FreeRDP progressive_wb_context: flags at a fixed offset.
				// From capture: body = 00 40 00 01 → flags often last meaningful byte.
				// FreeRDP reads: UINT8 ctxId, UINT8 tileSize, UINT8 flags (approx).
				if len(blockData) >= 3 {
					d.contextFlags = blockData[2]
				} else if len(blockData) >= 1 {
					d.contextFlags = blockData[len(blockData)-1]
				}
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
	return rfxQuant{
		LL3: data[0] & 0x0F,
		LH3: data[0] >> 4,
		HL3: data[1] & 0x0F,
		HH3: data[1] >> 4,
		LH2: data[2] & 0x0F,
		HL2: data[2] >> 4,
		HH2: data[3] & 0x0F,
		LH1: data[3] >> 4,
		HL1: data[4] & 0x0F,
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
func quantLSub(q rfxQuant, val uint8) rfxQuant {
	sub := func(v uint8) uint8 {
		if v < val {
			return 0
		}
		return v - val
	}
	return rfxQuant{
		LL3: sub(q.LL3), HL3: sub(q.HL3), LH3: sub(q.LH3), HH3: sub(q.HH3),
		HL2: sub(q.HL2), LH2: sub(q.LH2), HH2: sub(q.HH2),
		HL1: sub(q.HL1), LH1: sub(q.LH1), HH1: sub(q.HH1),
	}
}

func progQuantForQuality(prog []progressiveQuant, quality uint8) (rfxQuant, rfxQuant, rfxQuant) {
	// quality 0xFF means "full" (all-zero progressive quant) per FreeRDP.
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

	// FreeRDP: shift = quant + progQuant - 1
	shiftY := quantLSub(quantAdd(qY, pqY), 1)
	shiftCb := quantLSub(quantAdd(qCb, pqCb), 1)
	shiftCr := quantLSub(quantAdd(qCr, pqCr), 1)

	coeffDiff := flags&rfxTileDifference != 0
	_ = subbandDiff // FreeRDP marks it unused in first-pass decode_component

	var yPixels, cbPixels, crPixels []int16
	var newY, newCb, newCr *coeffArr
	var signY, signCb, signCr *coeffArr

	decodeOne := func(data []byte, shift rfxQuant) (pix []int16, raw, sign *coeffArr) {
		return rfxDecodeComponentProgressive(data, shift, nil, extrapolate, coeffDiff)
	}

	if parallelComponents {
		var wg sync.WaitGroup
		wg.Go(func() { yPixels, newY, signY = decodeOne(yData, shiftY) })
		wg.Go(func() { cbPixels, newCb, signCb = decodeOne(cbData, shiftCb) })
		wg.Go(func() { crPixels, newCr, signCr = decodeOne(crData, shiftCr) })
		wg.Wait()
	} else {
		yPixels, newY, signY = decodeOne(yData, shiftY)
		cbPixels, newCb, signCb = decodeOne(cbData, shiftCb)
		crPixels, newCr, signCr = decodeOne(crData, shiftCr)
	}

	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)

	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
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

// decodeTileUpgrade handles PROGRESSIVE_WBT_TILE_UPGRADE (0xCCC7).
// Wire layout (FreeRDP progressive_tile_read_upgrade): 20-byte header
// qY,qCb,qCr,xIdx,yIdx,quality,ySrl,yRaw,cbSrl,cbRaw,crSrl,crRaw
// then six data segments. Current implementation: if no cached state, ignore;
// if cached, re-decode is best-effort by treating concatenated raw as RLGR
// delta (SRL bitplane upgrade is not yet fully ported — upgrade frames are
// rare in the captured stream which is almost all TILE_FIRST).
func (d *rfxProgressiveDecoder) decodeTileUpgrade(data []byte, quants []rfxQuant, prog []progressiveQuant, output []byte, outW, outH int, extrapolate, subbandDiff, parallelComponents bool) {
	if len(data) < 20 {
		return
	}
	// For the captured session, upgrades are not the first-frame failure mode
	// (frame 0 is pure TILE_FIRST). Keep a conservative path: re-render from
	// cached raw coefficients with updated progressive quant if present.
	quantIdxY, quantIdxCb, quantIdxCr := data[0], data[1], data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	quality := data[7]
	// ySrlLen := binary.LittleEndian.Uint16(data[8:])
	// ... remaining lengths at 10..19

	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
	d.mu.RLock()
	cached := d.tileCache[tileKey]
	d.mu.RUnlock()
	if cached == nil || cached.y == nil || cached.cb == nil || cached.cr == nil {
		return
	}

	qY := rfxGetQuant(quants, int(quantIdxY))
	qCb := rfxGetQuant(quants, int(quantIdxCb))
	qCr := rfxGetQuant(quants, int(quantIdxCr))
	pqY, pqCb, pqCr := progQuantForQuality(prog, quality)
	shiftY := quantLSub(quantAdd(qY, pqY), 1)
	shiftCb := quantLSub(quantAdd(qCb, pqCb), 1)
	shiftCr := quantLSub(quantAdd(qCr, pqCr), 1)

	// Re-process cached raw coefficients with new shift (no new RLGR).
	yPixels := rfxProcessCachedRaw(cached.y, shiftY, extrapolate)
	cbPixels := rfxProcessCachedRaw(cached.cb, shiftCb, extrapolate)
	crPixels := rfxProcessCachedRaw(cached.cr, shiftCr, extrapolate)
	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)
	coeffPool.Put((*coeffArr)(yPixels))
	coeffPool.Put((*coeffArr)(cbPixels))
	coeffPool.Put((*coeffArr)(crPixels))
	_ = subbandDiff
	_ = parallelComponents
}

func rfxProcessCachedRaw(raw *coeffArr, shift rfxQuant, extrapolate bool) []int16 {
	arr := coeffPool.Get().(*coeffArr)
	work := arr[:]
	copy(work, (*raw)[:])
	if extrapolate {
		rfxDequantizeExtrapolate(work, shift)
		rfxInverseDWT2DExtrapolate(work)
	} else {
		// LL3 differential + dequant
		if shift.LL3 > 0 {
			s := shift.LL3
			work[4032] <<= s
			for i := 4033; i < 4096; i++ {
				work[i] = work[i-1] + work[i]<<s
			}
		} else {
			for i := 4033; i < 4096; i++ {
				work[i] += work[i-1]
			}
		}
		rfxDequantizeSkipLL3Prog(work, shift)
		rfxInverseDWT2D(work)
	}
	return work
}

// rfxDecodeComponentProgressive decodes one color component for a progressive
// TILE_FIRST/SIMPLE pass. Always RLGR1.
//
// Returns pixels (spatial domain, pooled), newRaw (pre-DWT coefficients for
// cache, pooled), and sign (copy of post-RLGR coeffs, pooled).
func rfxDecodeComponentProgressive(data []byte, shift rfxQuant, prevRaw *coeffArr, extrapolate, coeffDiff bool) (pixels []int16, newRaw, sign *coeffArr) {
	const tilePixels = rfxTileSize * rfxTileSize

	arr := coeffPool.Get().(*coeffArr)
	work := arr[:]

	if data == nil {
		clear(work)
	} else {
		work = rlgr1Decode(data, tilePixels, work)
	}

	// Sign copy (FreeRDP keeps post-RLGR buffer as sign).
	sign = coeffPool.Get().(*coeffArr)
	copy((*sign)[:], work[:tilePixels])

	// Cache raw coefficients for later upgrade / coeffDiff.
	newRaw = coeffPool.Get().(*coeffArr)
	if prevRaw != nil && coeffDiff {
		prev := (*prevRaw)[:]
		for i := range tilePixels {
			work[i] += prev[i]
		}
	}
	copy((*newRaw)[:], work[:tilePixels])

	if extrapolate {
		// FreeRDP extrapolate path: NO differential on LL3 first for non-extra;
		// for extrapolate: dequant bands with special sizes, then differential on LL3@4015.
		rfxDequantizeExtrapolate(work, shift)
		// differential on LL3 (81 coeffs at 4015)
		rfxDifferentialDecode(work[4015:4015+81], shift.LL3)
		rfxInverseDWT2DExtrapolate(work)
	} else {
		// FreeRDP non-extrapolate: differential on LL3@4032 then dequant all bands.
		rfxDifferentialDecode(work[4032:4096], shift.LL3)
		rfxDequantizeSkipLL3Prog(work, shift)
		rfxInverseDWT2D(work)
	}
	return work, newRaw, sign
}

// rfxDifferentialDecode applies FreeRDP rfx_differential_decode + optional shift.
// FreeRDP does differential first (unshifted), then shift. Our previous code
// fused them incorrectly for progressive (shift-before-cumsum with wrong order).
func rfxDifferentialDecode(band []int16, shift uint8) {
	// FreeRDP rfx_differential_decode: out[0]=in[0]; out[i]=out[i-1]+in[i]
	for i := 1; i < len(band); i++ {
		band[i] += band[i-1]
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

	for row := range n {
		rowOff := row * n
		lDstOff := row * size
		hDstOff := (row + n) * size
		prevEvenL := ll[rowOff] - int16((int32(hl[rowOff])*2+1)>>1)
		prevEvenH := lh[rowOff] - int16((int32(hh[rowOff])*2+1)>>1)
		tmp[lDstOff] = prevEvenL
		tmp[hDstOff] = prevEvenH
		for col := 1; col < n; col++ {
			x := col << 1
			evenL := ll[rowOff+col] - int16((int32(hl[rowOff+col-1])+int32(hl[rowOff+col])+1)>>1)
			evenH := lh[rowOff+col] - int16((int32(hh[rowOff+col-1])+int32(hh[rowOff+col])+1)>>1)
			tmp[lDstOff+x-1] = int16((int32(hl[rowOff+col-1]) << 1) + ((int32(prevEvenL) + int32(evenL)) >> 1))
			tmp[hDstOff+x-1] = int16((int32(hh[rowOff+col-1]) << 1) + ((int32(prevEvenH) + int32(evenH)) >> 1))
			tmp[lDstOff+x] = evenL
			tmp[hDstOff+x] = evenH
			prevEvenL = evenL
			prevEvenH = evenH
		}
		x := (n - 1) << 1
		tmp[lDstOff+x+1] = int16((int32(hl[rowOff+n-1]) << 1) + int32(prevEvenL))
		tmp[hDstOff+x+1] = int16((int32(hh[rowOff+n-1]) << 1) + int32(prevEvenH))
	}

	const blk = 8
	col := 0
	for ; col+blk <= size; col += blk {
		l0 := tmp[col : col+blk]
		h0 := tmp[n*size+col : n*size+col+blk]
		out0 := buf[col : col+blk]
		for b := range blk {
			out0[b] = int16(int32(l0[b]) - ((int32(h0[b])*2 + 1) >> 1))
		}
		for row := 1; row < n; row++ {
			lBase := row*size + col
			hBase := (row+n)*size + col
			hPrevBase := (row-1+n)*size + col
			evenBase := 2*row*size + col
			prevEvenBase := (2*row-2)*size + col
			oddBase := (2*row-1)*size + col
			l := tmp[lBase : lBase+blk]
			h := tmp[hBase : hBase+blk]
			hPrev := tmp[hPrevBase : hPrevBase+blk]
			evenOut := buf[evenBase : evenBase+blk]
			prevEvenIn := buf[prevEvenBase : prevEvenBase+blk]
			oddOut := buf[oddBase : oddBase+blk]
			for b := range blk {
				hPrevV := int32(hPrev[b])
				even := int32(l[b]) - ((hPrevV + int32(h[b]) + 1) >> 1)
				evenOut[b] = int16(even)
				oddOut[b] = int16((hPrevV << 1) + ((int32(prevEvenIn[b]) + even) >> 1))
			}
		}
		lastEvenBase := (2*n-2)*size + col
		lastHBase := (2*n-1)*size + col
		lastEvenSlice := buf[lastEvenBase : lastEvenBase+blk]
		lastHSlice := tmp[lastHBase : lastHBase+blk]
		lastOddOut := buf[lastHBase : lastHBase+blk]
		for b := range blk {
			lastOddOut[b] = int16((int32(lastHSlice[b]) << 1) + int32(lastEvenSlice[b]))
		}
	}
	for ; col < size; col++ {
		lVal := int32(tmp[col])
		hVal := int32(tmp[n*size+col])
		buf[col] = int16(lVal - ((hVal*2 + 1) >> 1))
		for row := 1; row < n; row++ {
			lIdx := row*size + col
			hIdx := (row+n)*size + col
			hPrevIdx := (row-1+n)*size + col
			even := int32(tmp[lIdx]) - ((int32(tmp[hPrevIdx]) + int32(tmp[hIdx]) + 1) >> 1)
			buf[2*row*size+col] = int16(even)
			prevEven := int32(buf[(2*row-2)*size+col])
			odd := (int32(tmp[hPrevIdx]) << 1) + ((prevEven + even) >> 1)
			buf[(2*row-1)*size+col] = int16(odd)
		}
		lastEven := int32(buf[(2*n-2)*size+col])
		lastH := int32(tmp[(2*n-1)*size+col])
		buf[(2*n-1)*size+col] = int16((lastH << 1) + lastEven)
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
