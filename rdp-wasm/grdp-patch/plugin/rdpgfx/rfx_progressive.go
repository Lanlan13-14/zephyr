package rdpgfx

// RFX Progressive Codec decoder (MS-RDPRFX / MS-RDPEGFX 2.2.4).
// Handles RDPGFX_CODECID_CAPROGRESSIVE (0x0009) in WIRE_TO_SURFACE_PDU_2.

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
)

const rfxTileSize = 64

// rfxQuant holds the 10 quantization values for one component (5 bytes, 10 nibbles).
type rfxQuant struct {
	LL3, LH3, HL3, HH3 uint8
	LH2, HL2, HH2      uint8
	LH1, HL1, HH1      uint8
}

// rfxTileCoeffs holds the raw RLGR-decoded coefficients for one tile (all three
// components), stored before LL3 differential decode and dequantization.  This
// state is required to apply TILE_UPGRADE_FIRST delta data on top of a previous
// TILE_FIRST (or TILE_SIMPLE) pass.
//
// The fields use *coeffArr (pooled) rather than []int16 to eliminate a
// heap allocation per tile per frame.  Callers must return these to
// coeffPool when replacing or discarding a cache entry.
type rfxTileCoeffs struct {
	y  *coeffArr
	cb *coeffArr
	cr *coeffArr
}

type rfxProgTileWork struct {
	tileType uint16
	data     []byte
}

type rfxProgressiveDecoder struct {
	mu        sync.RWMutex
	tileCache map[uint32]*rfxTileCoeffs // key: yIdx<<16 | xIdx
	rectsBuf  []rfxRect
	quantsBuf []rfxQuant
	tilesBuf  []rfxProgTileWork
}

func newRfxProgressiveDecoder() *rfxProgressiveDecoder {
	return &rfxProgressiveDecoder{
		tileCache: make(map[uint32]*rfxTileCoeffs),
	}
}

// Reset discards the tile coefficient cache.  Call this whenever the server
// starts a new progressive sequence (e.g. on RESET_GRAPHICS).
func (d *rfxProgressiveDecoder) Reset() {
	d.mu.Lock()
	old := d.tileCache
	d.tileCache = make(map[uint32]*rfxTileCoeffs)
	d.mu.Unlock()
	// Return all cached coefficient arrays to the pool.
	for _, tc := range old {
		if tc != nil {
			if tc.y != nil {
				coeffPool.Put(tc.y)
			}
			if tc.cb != nil {
				coeffPool.Put(tc.cb)
			}
			if tc.cr != nil {
				coeffPool.Put(tc.cr)
			}
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
		case progWBTSync, progWBTFrameBegin, progWBTFrameEnd, progWBTContext:
		// Infrastructure blocks — no action needed.
		case progWBTRegion:
			// Tiles are embedded inside the region block; parseRegion decodes them.
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
// Per MS-RDPEGFX 2.2.4, tile blocks (TILE_SIMPLE/TILE_FIRST) are sub-blocks
// inside the REGION block, not top-level stream blocks.
func (d *rfxProgressiveDecoder) parseRegion(data []byte, surfData []byte, outW, outH int) ([]rfxRect, []rfxQuant) {
	if len(data) < 12 {
		return nil, nil
	}

	// tileSize := data[0]
	numRects := binary.LittleEndian.Uint16(data[1:])
	numQuant := data[3]
	numProgQuant := data[4]
	// flags := data[5]
	numTiles := binary.LittleEndian.Uint16(data[6:])
	// tileDataSize := binary.LittleEndian.Uint32(data[8:])

	offset := 12

	// Parse rects (8 bytes each: x, y, width, height as uint16)
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

	// Parse quant values (5 bytes each)
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
		quants[i] = parseRfxQuant(data[offset:])
		offset += 5
	}

	// Skip progressive quant values (RFX_PROGRESSIVE_CODEC_QUANT, 16 bytes each)
	offset += int(numProgQuant) * 16

	// Collect all decodable tiles before dispatching, so we can parallelise
	// when there are enough to amortise goroutine overhead (same threshold as
	// non-progressive decodeTileset in rfx.go).
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

	const parallelTileThreshold = 12
	decodeTile := func(tw rfxProgTileWork, parallel bool) {
		switch tw.tileType {
		case progWBTTileSimple:
			d.decodeTileSimple(tw.data, quants, surfData, outW, outH, parallel)
		case progWBTTileFirst:
			d.decodeTileFirst(tw.data, quants, surfData, outW, outH, parallel)
		case progWBTTileUpgrade:
			d.decodeTileUpgrade(tw.data, quants, surfData, outW, outH, parallel)
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

// decodeTileSimple handles PROGRESSIVE_WBT_TILE_SIMPLE (0xCCC5).
// When parallelComponents is true the Y, Cb, and Cr channels are decoded
// concurrently. Use true for the serial-tile path.
func (d *rfxProgressiveDecoder) decodeTileSimple(data []byte, quants []rfxQuant, output []byte, outW, outH int, parallelComponents bool) {
	if len(data) < 16 {
		return
	}

	quantIdxY := data[0]
	quantIdxCb := data[1]
	quantIdxCr := data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	// flags := data[7]
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

	qY := rfxGetQuant(quants, int(quantIdxY))
	qCb := rfxGetQuant(quants, int(quantIdxCb))
	qCr := rfxGetQuant(quants, int(quantIdxCr))

	var yPixels, cbPixels, crPixels []int16
	var newY, newCb, newCr *coeffArr
	if parallelComponents {
		var wg sync.WaitGroup
		wg.Go(func() { yPixels, newY = rfxDecodeComponentProgressive(yData, qY, nil) })
		wg.Go(func() { cbPixels, newCb = rfxDecodeComponentProgressive(cbData, qCb, nil) })
		wg.Go(func() { crPixels, newCr = rfxDecodeComponentProgressive(crData, qCr, nil) })
		wg.Wait()
	} else {
		yPixels, newY = rfxDecodeComponentProgressive(yData, qY, nil)
		cbPixels, newCb = rfxDecodeComponentProgressive(cbData, qCb, nil)
		crPixels, newCr = rfxDecodeComponentProgressive(crData, qCr, nil)
	}

	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)

	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
	d.mu.Lock()
	old := d.tileCache[tileKey]
	d.tileCache[tileKey] = &rfxTileCoeffs{y: newY, cb: newCb, cr: newCr}
	d.mu.Unlock()
	if old != nil {
		if old.y != nil {
			coeffPool.Put(old.y)
		}
		if old.cb != nil {
			coeffPool.Put(old.cb)
		}
		if old.cr != nil {
			coeffPool.Put(old.cr)
		}
	}

	coeffPool.Put((*coeffArr)(yPixels))
	coeffPool.Put((*coeffArr)(cbPixels))
	coeffPool.Put((*coeffArr)(crPixels))
}
// When parallelComponents is true the Y, Cb, and Cr channels are decoded
// concurrently. Use true for the serial-tile path.
func (d *rfxProgressiveDecoder) decodeTileFirst(data []byte, quants []rfxQuant, output []byte, outW, outH int, parallelComponents bool) {
	if len(data) < 17 {
		return
	}

	quantIdxY := data[0]
	quantIdxCb := data[1]
	quantIdxCr := data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	// flags := data[7]
	// quality := data[8]
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

	qY := rfxGetQuant(quants, int(quantIdxY))
	qCb := rfxGetQuant(quants, int(quantIdxCb))
	qCr := rfxGetQuant(quants, int(quantIdxCr))

	var yPixels, cbPixels, crPixels []int16
	var newY, newCb, newCr *coeffArr
	if parallelComponents {
		var wg sync.WaitGroup
		wg.Go(func() { yPixels, newY = rfxDecodeComponentProgressive(yData, qY, nil) })
		wg.Go(func() { cbPixels, newCb = rfxDecodeComponentProgressive(cbData, qCb, nil) })
		wg.Go(func() { crPixels, newCr = rfxDecodeComponentProgressive(crData, qCr, nil) })
		wg.Wait()
	} else {
		yPixels, newY = rfxDecodeComponentProgressive(yData, qY, nil)
		cbPixels, newCb = rfxDecodeComponentProgressive(cbData, qCb, nil)
		crPixels, newCr = rfxDecodeComponentProgressive(crData, qCr, nil)
	}

	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)

	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
	d.mu.Lock()
	old := d.tileCache[tileKey]
	d.tileCache[tileKey] = &rfxTileCoeffs{y: newY, cb: newCb, cr: newCr}
	d.mu.Unlock()
	if old != nil {
		if old.y != nil {
			coeffPool.Put(old.y)
		}
		if old.cb != nil {
			coeffPool.Put(old.cb)
		}
		if old.cr != nil {
			coeffPool.Put(old.cr)
		}
	}

	coeffPool.Put((*coeffArr)(yPixels))
	coeffPool.Put((*coeffArr)(cbPixels))
	coeffPool.Put((*coeffArr)(crPixels))
}
// The upgrade data contains RLGR-encoded delta coefficients that are added to
// the raw coefficients cached from the preceding TILE_FIRST (or TILE_SIMPLE)
// pass.  If no cached state exists for the tile (e.g. the session started
// mid-stream), the delta is decoded as if it were a standalone tile so that
// at least some image is rendered rather than nothing.
func (d *rfxProgressiveDecoder) decodeTileUpgrade(data []byte, quants []rfxQuant, output []byte, outW, outH int, parallelComponents bool) {
	if len(data) < 17 {
		return
	}

	quantIdxY := data[0]
	quantIdxCb := data[1]
	quantIdxCr := data[2]
	xIdx := binary.LittleEndian.Uint16(data[3:])
	yIdx := binary.LittleEndian.Uint16(data[5:])
	// flags := data[7]
	// quality := data[8]
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

	qY := rfxGetQuant(quants, int(quantIdxY))
	qCb := rfxGetQuant(quants, int(quantIdxCb))
	qCr := rfxGetQuant(quants, int(quantIdxCr))

	tileKey := uint32(yIdx)<<16 | uint32(xIdx)
	d.mu.RLock()
	cached := d.tileCache[tileKey]
	d.mu.RUnlock()

	var prevY, prevCb, prevCr *coeffArr
	if cached != nil {
		prevY, prevCb, prevCr = cached.y, cached.cb, cached.cr
	}

	var yPixels, cbPixels, crPixels []int16
	var newY, newCb, newCr *coeffArr
	if parallelComponents {
		var wg sync.WaitGroup
		wg.Go(func() { yPixels, newY = rfxDecodeComponentProgressive(yData, qY, prevY) })
		wg.Go(func() { cbPixels, newCb = rfxDecodeComponentProgressive(cbData, qCb, prevCb) })
		wg.Go(func() { crPixels, newCr = rfxDecodeComponentProgressive(crData, qCr, prevCr) })
		wg.Wait()
	} else {
		yPixels, newY = rfxDecodeComponentProgressive(yData, qY, prevY)
		cbPixels, newCb = rfxDecodeComponentProgressive(cbData, qCb, prevCb)
		crPixels, newCr = rfxDecodeComponentProgressive(crData, qCr, prevCr)
	}

	rfxPlaceTile(yPixels, cbPixels, crPixels, int(xIdx), int(yIdx), output, outW, outH)

	d.mu.Lock()
	d.tileCache[tileKey] = &rfxTileCoeffs{y: newY, cb: newCb, cr: newCr}
	d.mu.Unlock()

	// Return the old cached coefficient arrays to the pool now that they are
	// no longer referenced (the new entry has been stored above).
	if cached != nil {
		if cached.y != nil {
			coeffPool.Put(cached.y)
		}
		if cached.cb != nil {
			coeffPool.Put(cached.cb)
		}
		if cached.cr != nil {
			coeffPool.Put(cached.cr)
		}
	}

	coeffPool.Put((*coeffArr)(yPixels))
	coeffPool.Put((*coeffArr)(cbPixels))
	coeffPool.Put((*coeffArr)(crPixels))
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

// rfxDecodeComponentProgressive decodes one color component for a progressive
// tile pass.  It always uses RLGR mode 1 (required by the progressive codec).
//
// If prevRaw is non-nil, it contains the raw RLGR-decoded coefficients from
// the preceding TILE_FIRST/TILE_SIMPLE pass; the newly decoded values are
// treated as a delta and added to prevRaw before processing.  Pass nil for
// the first pass (TILE_FIRST / TILE_SIMPLE).
//
// Returns:
//   - pixels: the fully decoded tile coefficients (pooled; caller must return
//     via coeffPool.Put((*coeffArr)(pixels)) when done).
//   - newRaw: the combined raw coefficients before LL3 differential decode and
//     dequantization; pooled — the caller must return via coeffPool.Put(newRaw)
//     when it is no longer needed (e.g. when replacing the tile cache entry).
func rfxDecodeComponentProgressive(data []byte, quant rfxQuant, prevRaw *coeffArr) (pixels []int16, newRaw *coeffArr) {
	const tilePixels = rfxTileSize * rfxTileSize

	arr := coeffPool.Get().(*coeffArr)
	work := arr[:]

	if data == nil {
		clear(work)
	} else {
		// Progressive codec always uses RLGR mode 1.
		work = rlgr1Decode(data, tilePixels, work)
	}

	// Add delta from the previous quality pass when upgrading.
	if prevRaw != nil {
		prev := (*prevRaw)[:]
		for i := range tilePixels {
			work[i] += prev[i]
		}
	}

	// Cache the combined raw coefficients in a pooled buffer so a future
	// upgrade pass can add its own delta on top — avoids a heap allocation.
	newRaw = coeffPool.Get().(*coeffArr)
	copy((*newRaw)[:], work[:tilePixels])

	// Apply LL3 differential decode and dequantize LL3 in a single pass
	// (identical to rfxDecodeComponent step 2).
	if quant.LL3 > 1 {
		shift := quant.LL3 - 1
		work[4032] <<= shift
		for i := 4033; i < 4096; i++ {
			work[i] = work[i-1] + work[i]<<shift
		}
	} else {
		for i := 4033; i < 4096; i++ {
			work[i] += work[i-1]
		}
	}

	rfxDequantizeSkipLL3(work, quant)
	rfxInverseDWT2D(work)

	return work, newRaw
}

// rfxDecodeComponent decodes one color component (Y, Cb, or Cr) for a 64×64 tile.
// The returned slice is backed by a *coeffArr from coeffPool; the caller must
// return it via coeffPool.Put((*coeffArr)(result)) when done.
func rfxDecodeComponent(data []byte, quant rfxQuant, rlgrMode int) []int16 {
	const tilePixels = rfxTileSize * rfxTileSize // 4096

	// Get a pooled coefficient buffer. The pool stores *coeffArr (pointer to a
	// fixed-size array) so the any interface stores a single pointer word with no
	// heap-boxing allocation.
	arr := coeffPool.Get().(*coeffArr)
	coeffs := arr[:]

	if data == nil {
		clear(coeffs)
		return coeffs
	}

	// 1. RLGR entropy decode → 4096 coefficients
	if rlgrMode == 3 {
		coeffs = rlgr3Decode(data, tilePixels, coeffs)
	} else {
		coeffs = rlgr1Decode(data, tilePixels, coeffs)
	}

	// 2. Differential decode LL3 and dequantize LL3 in a single pass.
	// Mathematical identity: cumsum(x) * 2^s == cumsum_of(x * 2^s)
	// so we can left-shift each element before accumulating.
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

	// 3. Dequantize all subbands except LL3 (handled above)
	rfxDequantizeSkipLL3(coeffs, quant)

	// 4. Inverse DWT (3 levels)
	rfxInverseDWT2D(coeffs)

	return coeffs
}

// rfxDequantizeSkipLL3 applies dequantization per subband, skipping LL3
// (which is handled together with differential decode in rfxDecodeComponent).
func rfxDequantizeSkipLL3(coeffs []int16, q rfxQuant) {
	rfxShiftSubband(coeffs[0:1024], q.HL1)    // HL1
	rfxShiftSubband(coeffs[1024:2048], q.LH1) // LH1
	rfxShiftSubband(coeffs[2048:3072], q.HH1) // HH1
	rfxShiftSubband(coeffs[3072:3328], q.HL2) // HL2
	rfxShiftSubband(coeffs[3328:3584], q.LH2) // LH2
	rfxShiftSubband(coeffs[3584:3840], q.HH2) // HH2
	rfxShiftSubband(coeffs[3840:3904], q.HL3) // HL3
	rfxShiftSubband(coeffs[3904:3968], q.LH3) // LH3
	rfxShiftSubband(coeffs[3968:4032], q.HH3) // HH3
}

func rfxShiftSubband(data []int16, factor uint8) {
	if factor <= 1 {
		return
	}
	shift := factor - 1
	for i := range data {
		data[i] <<= shift
	}
}

// rfxInverseDWT2D performs 3-level inverse 2D discrete wavelet transform in-place.
// Buffer layout: [HL1(1024)|LH1(1024)|HH1(1024)|HL2(256)|LH2(256)|HH2(256)|HL3(64)|LH3(64)|HH3(64)|LL3(64)]
// A single temporary buffer is obtained from the pool and reused across all three
// levels, reducing pool pressure from 9 Get/Put calls (3 levels × 3 components) to 3.
func rfxInverseDWT2D(coeffs []int16) {
	bufs := idwtBufPool.Get().(*idwtBufs)
	// Level 3: 8×8 subbands → 16×16 output  (needs 16×16 = 256 elements)
	rfxIDWT2DLevel(coeffs[3840:], bufs.tmp[:256], 8)
	// Level 2: 16×16 subbands → 32×32 output (needs 32×32 = 1024 elements)
	rfxIDWT2DLevel(coeffs[3072:], bufs.tmp[:1024], 16)
	// Level 1: 32×32 subbands → 64×64 output (needs 64×64 = 4096 elements)
	rfxIDWT2DLevel(coeffs[0:], bufs.tmp[:4096], 32)
	idwtBufPool.Put(bufs)
}

// rfxIDWT2DLevel performs one level of inverse 2D DWT.
// buf contains [HL(n²)|LH(n²)|HH(n²)|LL(n²)] and is replaced with the (2n)×(2n) result.
// tmp is a caller-supplied scratch buffer of length (2n)² (must be ≥ 4n² elements).
// Uses the MS-RDPRFX lifting scheme. Order: horizontal IDWT first, then vertical.
func rfxIDWT2DLevel(buf, tmp []int16, n int) {
	nn := n * n
	size := 2 * n

	// Read subbands directly from buf — no copy needed because the horizontal
	// pass only reads from them and writes exclusively to tmp.
	hl := buf[0:nn]
	lh := buf[nn : 2*nn]
	hh := buf[2*nn : 3*nn]
	ll := buf[3*nn : 4*nn]

	// Step 1: Horizontal IDWT on each row (fused even+odd passes).
	// Instead of two separate loops — even pass writing to tmp, then odd pass
	// re-reading those values — we keep the last even value in a register and
	// compute the preceding odd value in the same iteration.  This eliminates
	// 2*(n-1) reads of tmp per row (one even[col-1] and one even[col] per odd
	// position), replacing them with register references.
	// Valid sizes in practice: n = 8, 16, 32.
	for row := range n {
		rowOff := row * n
		lDstOff := row * size
		hDstOff := (row + n) * size

		// col=0: even boundary (no left neighbour, hl[-1] = hl[0]).
		prevEvenL := ll[rowOff] - int16((int32(hl[rowOff])*2+1)>>1)
		prevEvenH := lh[rowOff] - int16((int32(hh[rowOff])*2+1)>>1)
		tmp[lDstOff] = prevEvenL
		tmp[hDstOff] = prevEvenH

		// col=1..n-1: compute even[col], then immediately compute odd[col-1]
		// using prevEven (=even[col-1], still in register) and the just-computed
		// even[col] — no re-read of tmp required.
		for col := 1; col < n; col++ {
			x := col << 1
			evenL := ll[rowOff+col] - int16((int32(hl[rowOff+col-1])+int32(hl[rowOff+col])+1)>>1)
			evenH := lh[rowOff+col] - int16((int32(hh[rowOff+col-1])+int32(hh[rowOff+col])+1)>>1)
			tmp[lDstOff+x-1] = int16((int32(hl[rowOff+col-1])<<1) + ((int32(prevEvenL)+int32(evenL))>>1))
			tmp[hDstOff+x-1] = int16((int32(hh[rowOff+col-1])<<1) + ((int32(prevEvenH)+int32(evenH))>>1))
			tmp[lDstOff+x] = evenL
			tmp[hDstOff+x] = evenH
			prevEvenL = evenL
			prevEvenH = evenH
		}

		// last odd[n-1]: right boundary, even[n] = even[n-1].
		x := (n - 1) << 1
		tmp[lDstOff+x+1] = int16((int32(hl[rowOff+n-1])<<1) + int32(prevEvenL))
		tmp[hDstOff+x+1] = int16((int32(hh[rowOff+n-1])<<1) + int32(prevEvenH))
	}

	// Step 2: Vertical IDWT on each column.
	// Process 8 columns at a time to improve cache utilisation — a cache line
	// holds 32 int16 values; 8 columns keeps the working set within one or two
	// lines per row access. All valid sizes (16, 32, 64) divide evenly by 8,
	// so the scalar tail loop is never reached in practice.
	const blk = 8
	col := 0
	for ; col+blk <= size; col += blk {
		// Row 0: first even output (no previous odd)
		l0 := tmp[col : col+blk]
		h0 := tmp[n*size+col : n*size+col+blk]
		out0 := buf[col : col+blk]
		for b := range blk {
			out0[b] = int16(int32(l0[b]) - ((int32(h0[b])*2 + 1) >> 1))
		}
		// Rows 1..n-1: interleaved even/odd outputs
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
		// Last odd row
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

// rfxPlaceTile converts YCbCr tile to BGRA using tile-grid indices (xIdx, yIdx).
func rfxPlaceTile(yCoeffs, cbCoeffs, crCoeffs []int16, xIdx, yIdx int, output []byte, outW, outH int) {
	rfxPlaceTileAbs(yCoeffs, cbCoeffs, crCoeffs, xIdx*rfxTileSize, yIdx*rfxTileSize, output, outW, outH)
}

// rfxPlaceTileAbs converts YCbCr tile to BGRA and writes into the output buffer
// at absolute pixel coordinates (tileX, tileY).
// Uses ICT (Irreversible Color Transform) from MS-RDPRFX.
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
