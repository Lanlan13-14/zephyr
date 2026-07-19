package rdpgfx

// Differential test harness: Go RFX Progressive decoder vs FreeRDP reference.
//
// Modes (env):
//   PROGDIFF_DIR  - case directory root (required)
//   PROGDIFF_MODE - "gen" writes payload cases; "go" decodes them with the Go
//                   decoder writing go.NN.raw per payload next to the payloads.
//
// The FreeRDP C harness (tests/progdiff/progdiff.c) decodes the same payloads
// writing c.NN.raw. tests/progdiff/run.sh orchestrates and compares.
//
// The encoders below (RLGR1, SRL/RAW) exist only to produce spec-valid wire
// data; each is round-trip validated against the production Go decoders.

import (
	"encoding/binary"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// MSB-first bit writer (matches FreeRDP wBitStream / Go rlgrBitReader order)
// ---------------------------------------------------------------------------

type pdBitWriter struct {
	buf   []byte
	nbits int
}

func (w *pdBitWriter) writeBit(b int) {
	if w.nbits%8 == 0 {
		w.buf = append(w.buf, 0)
	}
	if b != 0 {
		w.buf[len(w.buf)-1] |= 1 << (7 - (w.nbits % 8))
	}
	w.nbits++
}

func (w *pdBitWriter) writeBits(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		w.writeBit(int((v >> i) & 1))
	}
}

func (w *pdBitWriter) writeOnes(n int) {
	for i := 0; i < n; i++ {
		w.writeBit(1)
	}
}

// ---------------------------------------------------------------------------
// RLGR1 encoder (MS-RDPRFX 3.1.8.1.7 inverse)
// ---------------------------------------------------------------------------

func pdRlgr1Encode(coefs []int16) []byte {
	w := &pdBitWriter{}
	kp, krp := 8, 8
	k, kr := 1, 1
	n := len(coefs)
	i := 0
	for i < n {
		if k > 0 {
			// RL mode
			run := 0
			for i+run < n && coefs[i+run] == 0 {
				run++
			}
			total := run
			if i+run >= n {
				// Trailing zeros: emit run groups until the decoder's output
				// is full; both decoders stop once outputSize is reached.
				for run > 0 {
					w.writeBit(0)
					if run >= (1 << k) {
						run -= 1 << k
					} else {
						run = 0
					}
					kp += 4
					if kp > 80 {
						kp = 80
					}
					k = kp >> 3
				}
				break
			}
			for run >= (1 << k) {
				w.writeBit(0)
				run -= 1 << k
				kp += 4
				if kp > 80 {
					kp = 80
				}
				k = kp >> 3
			}
			w.writeBit(1)
			if k > 0 {
				w.writeBits(uint32(run), k)
			}
			i += total
			v := int(coefs[i])
			i++
			sign := 0
			if v < 0 {
				sign = 1
				v = -v
			}
			w.writeBit(sign)
			code := uint32(v - 1)
			vk := int(code >> kr)
			w.writeOnes(vk)
			w.writeBit(0)
			if kr > 0 {
				w.writeBits(code&uint32((1<<kr)-1), kr)
			}
			if vk == 0 {
				krp -= 2
				if krp < 0 {
					krp = 0
				}
			} else if vk != 1 {
				krp += vk
				if krp > 80 {
					krp = 80
				}
			}
			kr = krp >> 3
			kp -= 6
			if kp < 0 {
				kp = 0
			}
			k = kp >> 3
		} else {
			// GR mode
			v := int(coefs[i])
			i++
			var code uint32
			switch {
			case v == 0:
				code = 0
			case v > 0:
				code = uint32(2 * v)
			default:
				code = uint32(2*(-v) - 1)
			}
			vk := int(code >> kr)
			w.writeOnes(vk)
			w.writeBit(0)
			if kr > 0 {
				w.writeBits(code&uint32((1<<kr)-1), kr)
			}
			if vk == 0 {
				krp -= 2
				if krp < 0 {
					krp = 0
				}
			} else if vk != 1 {
				krp += vk
				if krp > 80 {
					krp = 80
				}
			}
			kr = krp >> 3
			if code == 0 {
				kp += 3
				if kp > 80 {
					kp = 80
				}
			} else {
				kp -= 3
				if kp < 0 {
					kp = 0
				}
			}
			k = kp >> 3
		}
	}
	return w.buf
}

// ---------------------------------------------------------------------------
// SRL/RAW upgrade stream encoder (inverse of FreeRDP progressive_rfx_srl_read)
// ---------------------------------------------------------------------------

type pdSrlEncoder struct {
	srl  *pdBitWriter
	raw  *pdBitWriter
	nz   int
	kp   int
	mode bool
}

func newPdSrlEncoder() *pdSrlEncoder {
	return &pdSrlEncoder{srl: &pdBitWriter{}, raw: &pdBitWriter{}, kp: 8}
}

// encodeSrlSeq encodes the SRL subsequence (signed deltas at sign==0
// positions, in band order) into the SRL stream. nbs[i] is the numBits of
// the band vals[i] belongs to (used only for unary magnitude coding; zero
// runs are band-agnostic, exactly like the decoder's global state machine).
func (e *pdSrlEncoder) encodeSrlSeq(vals []int16, nbs []int) {
	j := 0
	for j < len(vals) {
		if e.nz > 0 {
			e.nz--
			j++
			continue
		}
		k := e.kp / 8
		if !e.mode {
			r := 0
			for j+r < len(vals) && vals[j+r] == 0 {
				r++
			}
			if r >= (1 << k) {
				e.srl.writeBit(0)
				e.kp += 4
				if e.kp > 80 {
					e.kp = 80
				}
				e.nz = (1 << k) - 1
				j++
				continue
			}
			e.srl.writeBit(1)
			if k > 0 {
				e.srl.writeBits(uint32(r), k)
			}
			e.mode = true
			if r > 0 {
				e.nz = r - 1
				j++
				continue
			}
			// r == 0: fall through to unary for vals[j]
		}
		// unary encode vals[j] (must be non-zero)
		v := vals[j]
		numBits := nbs[j]
		if v < 0 {
			e.srl.writeBit(1)
		} else {
			e.srl.writeBit(0)
		}
		e.kp -= 6
		if e.kp < 0 {
			e.kp = 0
		}
		if numBits > 1 {
			mag := int(v)
			if mag < 0 {
				mag = -mag
			}
			maxv := (1 << numBits) - 1
			zeros := mag - 1
			if zeros > maxv-1 {
				zeros = maxv - 1
			}
			for i := 0; i < zeros; i++ {
				e.srl.writeBit(0)
			}
			if mag < maxv {
				e.srl.writeBit(1)
			}
		}
		e.mode = false
		j++
	}
}

func (e *pdSrlEncoder) encodeRaw(v uint16, numBits int) {
	e.raw.writeBits(uint32(v), numBits)
}

// pdUpgradeBands describes the fixed band layout used by the upgrade path
// (FreeRDP uses the extrapolate layout unconditionally here).
var pdUpgradeBands = []struct {
	name   string
	off    int
	length int
	nonLL  bool
	get    func(*rfxQuant) uint8
}{
	{"HL1", 0, 1023, true, func(q *rfxQuant) uint8 { return q.HL1 }},
	{"LH1", 1023, 1023, true, func(q *rfxQuant) uint8 { return q.LH1 }},
	{"HH1", 2046, 961, true, func(q *rfxQuant) uint8 { return q.HH1 }},
	{"HL2", 3007, 272, true, func(q *rfxQuant) uint8 { return q.HL2 }},
	{"LH2", 3279, 272, true, func(q *rfxQuant) uint8 { return q.LH2 }},
	{"HH2", 3551, 256, true, func(q *rfxQuant) uint8 { return q.HH2 }},
	{"HL3", 3807, 72, true, func(q *rfxQuant) uint8 { return q.HL3 }},
	{"LH3", 3879, 72, true, func(q *rfxQuant) uint8 { return q.LH3 }},
	{"HH3", 3951, 64, true, func(q *rfxQuant) uint8 { return q.HH3 }},
	{"LL3", 4015, 81, false, func(q *rfxQuant) uint8 { return q.LL3 }},
}

// pdEncodeUpgradeComponent produces (srlData, rawData) for one component.
// sign holds the post-RLGR first-pass values; deltas are chosen by the caller:
//   - sign[i] > 0: rawVals entry in [0, 2^numBits)
//   - sign[i] < 0: rawVals entry in [0, 2^numBits)
//   - sign[i] == 0: srl signed delta with |v| <= 2^numBits - 1
//
// rawVals/srlVals are consumed in band order.
func pdEncodeUpgradeComponent(sign []int16, rawVals []uint16, srlVals []int16, numBits rfxQuant) (srlData, rawData []byte) {
	e := newPdSrlEncoder()
	srlIdx := 0
	rawIdx := 0
	// The SRL subsequence spans all non-LL bands in order; zero runs cross
	// band boundaries just like the decoder's global state machine.
	var srlSeq []int16
	var srlNb []int
	for _, b := range pdUpgradeBands {
		nb := int(b.get(&numBits))
		if nb < 1 {
			// Band skipped by both decoders: no bits consumed and the caller
			// generated no values for these positions.
			continue
		}
		if b.nonLL {
			for i := 0; i < b.length; i++ {
				if sign[b.off+i] == 0 {
					srlSeq = append(srlSeq, srlVals[srlIdx])
					srlNb = append(srlNb, nb)
					srlIdx++
				} else {
					e.encodeRaw(rawVals[rawIdx], nb)
					rawIdx++
				}
			}
		} else {
			for i := 0; i < b.length; i++ {
				e.encodeRaw(rawVals[rawIdx], nb)
				rawIdx++
			}
		}
	}
	e.encodeSrlSeq(srlSeq, srlNb)
	return e.srl.buf, e.raw.buf
}

// ---------------------------------------------------------------------------
// Wire block builders
// ---------------------------------------------------------------------------

func pdBlock(typ uint16, body []byte) []byte {
	out := make([]byte, 6+len(body))
	binary.LittleEndian.PutUint16(out, typ)
	binary.LittleEndian.PutUint32(out[2:], uint32(len(out)))
	copy(out[6:], body)
	return out
}

func pdSyncBlock() []byte {
	body := make([]byte, 6)
	binary.LittleEndian.PutUint32(body, 0xCACCACCA)
	binary.LittleEndian.PutUint16(body[4:], 0x0100)
	return pdBlock(progWBTSync, body)
}

func pdContextBlock(flags uint8) []byte {
	body := []byte{0x00, 0x40, 0x00, flags} // ctxId, tileSize u16=64, flags
	return pdBlock(progWBTContext, body)
}

func pdFrameBeginBlock(frameID uint32) []byte {
	body := make([]byte, 6)
	binary.LittleEndian.PutUint32(body, frameID)
	binary.LittleEndian.PutUint16(body[4:], 1)
	return pdBlock(progWBTFrameBegin, body)
}

func pdFrameEndBlock() []byte {
	return pdBlock(progWBTFrameEnd, nil)
}

func pdQuantBytes(q rfxQuant) []byte {
	return []byte{
		q.LL3 | q.HL3<<4,
		q.LH3 | q.HH3<<4,
		q.HL2 | q.LH2<<4,
		q.HH2 | q.HL1<<4,
		q.LH1 | q.HH1<<4,
	}
}

type pdTileOut struct {
	xIdx, yIdx uint16
	block      []byte
	sign       [3][]int16 // post-RLGR values per component (first/simple only)
	qualityIdx int        // ladder index used (-1 for simple/full)
}

func pdTileSimple(xIdx, yIdx uint16, quantIdx [3]uint8, flags uint8, y, cb, cr []byte) []byte {
	body := make([]byte, 16, 16+len(y)+len(cb)+len(cr))
	body[0], body[1], body[2] = quantIdx[0], quantIdx[1], quantIdx[2]
	binary.LittleEndian.PutUint16(body[3:], xIdx)
	binary.LittleEndian.PutUint16(body[5:], yIdx)
	body[7] = flags
	binary.LittleEndian.PutUint16(body[8:], uint16(len(y)))
	binary.LittleEndian.PutUint16(body[10:], uint16(len(cb)))
	binary.LittleEndian.PutUint16(body[12:], uint16(len(cr)))
	body = append(body, y...)
	body = append(body, cb...)
	body = append(body, cr...)
	return pdBlock(progWBTTileSimple, body)
}

func pdTileFirst(xIdx, yIdx uint16, quantIdx [3]uint8, flags, quality uint8, y, cb, cr []byte) []byte {
	body := make([]byte, 17, 17+len(y)+len(cb)+len(cr))
	body[0], body[1], body[2] = quantIdx[0], quantIdx[1], quantIdx[2]
	binary.LittleEndian.PutUint16(body[3:], xIdx)
	binary.LittleEndian.PutUint16(body[5:], yIdx)
	body[7] = flags
	body[8] = quality
	binary.LittleEndian.PutUint16(body[9:], uint16(len(y)))
	binary.LittleEndian.PutUint16(body[11:], uint16(len(cb)))
	binary.LittleEndian.PutUint16(body[13:], uint16(len(cr)))
	body = append(body, y...)
	body = append(body, cb...)
	body = append(body, cr...)
	return pdBlock(progWBTTileFirst, body)
}

func pdTileUpgrade(xIdx, yIdx uint16, quantIdx [3]uint8, quality uint8, ySrl, yRaw, cbSrl, cbRaw, crSrl, crRaw []byte) []byte {
	body := make([]byte, 20)
	body[0], body[1], body[2] = quantIdx[0], quantIdx[1], quantIdx[2]
	binary.LittleEndian.PutUint16(body[3:], xIdx)
	binary.LittleEndian.PutUint16(body[5:], yIdx)
	body[7] = quality
	binary.LittleEndian.PutUint16(body[8:], uint16(len(ySrl)))
	binary.LittleEndian.PutUint16(body[10:], uint16(len(yRaw)))
	binary.LittleEndian.PutUint16(body[12:], uint16(len(cbSrl)))
	binary.LittleEndian.PutUint16(body[14:], uint16(len(cbRaw)))
	binary.LittleEndian.PutUint16(body[16:], uint16(len(crSrl)))
	binary.LittleEndian.PutUint16(body[18:], uint16(len(crRaw)))
	body = append(body, ySrl...)
	body = append(body, yRaw...)
	body = append(body, cbSrl...)
	body = append(body, cbRaw...)
	body = append(body, crSrl...)
	body = append(body, crRaw...)
	return pdBlock(progWBTTileUpgrade, body)
}

func pdRegionBlock(rects [][4]uint16, quants []rfxQuant, progQuants []progressiveQuant, flags uint8, tiles [][]byte) []byte {
	tileDataSize := 0
	for _, t := range tiles {
		tileDataSize += len(t)
	}
	body := make([]byte, 12)
	body[0] = 64
	binary.LittleEndian.PutUint16(body[1:], uint16(len(rects)))
	body[3] = uint8(len(quants))
	body[4] = uint8(len(progQuants))
	body[5] = flags
	binary.LittleEndian.PutUint16(body[6:], uint16(len(tiles)))
	binary.LittleEndian.PutUint32(body[8:], uint32(tileDataSize))
	for _, r := range rects {
		rb := make([]byte, 8)
		binary.LittleEndian.PutUint16(rb[0:], r[0])
		binary.LittleEndian.PutUint16(rb[2:], r[1])
		binary.LittleEndian.PutUint16(rb[4:], r[2])
		binary.LittleEndian.PutUint16(rb[6:], r[3])
		body = append(body, rb...)
	}
	for _, q := range quants {
		body = append(body, pdQuantBytes(q)...)
	}
	for _, pq := range progQuants {
		body = append(body, pq.quality)
		body = append(body, pdQuantBytes(pq.y)...)
		body = append(body, pdQuantBytes(pq.cb)...)
		body = append(body, pdQuantBytes(pq.cr)...)
	}
	for _, t := range tiles {
		body = append(body, t...)
	}
	return pdBlock(progWBTRegion, body)
}

func pdFrame(frameID uint32, ctxFlags uint8, region []byte) []byte {
	out := pdSyncBlock()
	out = append(out, pdContextBlock(ctxFlags)...)
	out = append(out, pdFrameBeginBlock(frameID)...)
	out = append(out, region...)
	out = append(out, pdFrameEndBlock()...)
	return out
}

// ---------------------------------------------------------------------------
// Case generation
// ---------------------------------------------------------------------------

type pdGenState struct {
	rng *rand.Rand
	// per-tile pass state: key yIdx<<16|xIdx
	tileProg map[uint32]int // last ladder index (-1 => full/simple)
	tileSign map[uint32][3][]int16
}

func pdRandCoefs(rng *rand.Rand, mode string) []int16 {
	out := make([]int16, 4096)
	// Keep generated coefficients in the range produced by a real RFX
	// encoder. Arbitrary int16 values shifted by quantization overflow the
	// 16-bit IDWT domain and only compare architecture-specific wraparound
	// (FreeRDP SSE2 versus scalar Go), not codec conformance.
	switch mode {
	case "sparse":
		for i := range out {
			if rng.Intn(100) < 8 {
				out[i] = int16(rng.Intn(5) - 2)
			}
		}
	case "dense":
		for i := range out {
			out[i] = int16(rng.Intn(5) - 2)
		}
	case "extreme":
		for i := range out {
			switch rng.Intn(20) {
			case 0:
				out[i] = 4
			case 1:
				out[i] = -4
			case 2:
				out[i] = int16(rng.Intn(9) - 4)
			default:
				out[i] = 0
			}
		}
	case "mixed":
		for i := range out {
			if rng.Intn(100) < 50 {
				out[i] = int16(rng.Intn(5) - 2)
			}
		}
	}
	return out
}

// pdEmitFirst builds a TILE_FIRST (or SIMPLE when qualityIdx<0) for one tile
// and records the sign arrays.
func pdEmitFirst(gs *pdGenState, xIdx, yIdx uint16, quantIdx [3]uint8, flags uint8, qualityIdx int, ladder []progressiveQuant, coefMode string) pdTileOut {
	key := uint32(yIdx)<<16 | uint32(xIdx)
	comps := [3][]int16{pdRandCoefs(gs.rng, coefMode), pdRandCoefs(gs.rng, coefMode), pdRandCoefs(gs.rng, coefMode)}
	y := pdRlgr1Encode(comps[0])
	cb := pdRlgr1Encode(comps[1])
	cr := pdRlgr1Encode(comps[2])
	var block []byte
	if qualityIdx < 0 {
		block = pdTileSimple(xIdx, yIdx, quantIdx, flags, y, cb, cr)
		gs.tileProg[key] = -1
	} else {
		block = pdTileFirst(xIdx, yIdx, quantIdx, flags, uint8(qualityIdx), y, cb, cr)
		gs.tileProg[key] = qualityIdx
	}
	gs.tileSign[key] = [3][]int16{
		rlgr1Decode(y, 4096, nil),
		rlgr1Decode(cb, 4096, nil),
		rlgr1Decode(cr, 4096, nil),
	}
	return pdTileOut{xIdx: xIdx, yIdx: yIdx, block: block}
}

func pdEmitFirstCoefs(gs *pdGenState, xIdx, yIdx uint16, quantIdx [3]uint8, flags uint8, qualityIdx int, comps [3][]int16) pdTileOut {
	key := uint32(yIdx)<<16 | uint32(xIdx)
	y := pdRlgr1Encode(comps[0])
	cb := pdRlgr1Encode(comps[1])
	cr := pdRlgr1Encode(comps[2])
	block := pdTileFirst(xIdx, yIdx, quantIdx, flags, uint8(qualityIdx), y, cb, cr)
	gs.tileProg[key] = qualityIdx
	gs.tileSign[key] = [3][]int16{
		rlgr1Decode(y, 4096, nil),
		rlgr1Decode(cb, 4096, nil),
		rlgr1Decode(cr, 4096, nil),
	}
	return pdTileOut{xIdx: xIdx, yIdx: yIdx, block: block}
}

// pdEmitUpgrade builds a TILE_UPGRADE for one tile to ladder index newIdx
// (must be > last first-pass index so numBits stays non-negative per band).
func pdEmitUpgrade(gs *pdGenState, xIdx, yIdx uint16, quantIdx [3]uint8, newIdx int, quants []rfxQuant, ladder []progressiveQuant) pdTileOut {
	key := uint32(yIdx)<<16 | uint32(xIdx)
	oldIdx := gs.tileProg[key]
	signs := gs.tileSign[key]
	prog := [3]rfxQuant{ladder[newIdx].y, ladder[newIdx].cb, ladder[newIdx].cr}
	var oldProg [3]rfxQuant
	if oldIdx >= 0 {
		oldProg = [3]rfxQuant{ladder[oldIdx].y, ladder[oldIdx].cb, ladder[oldIdx].cr}
	}
	var datas [6][]byte
	for c := 0; c < 3; c++ {
		nb, _ := quantSub(quantAdd(rfxGetQuant(quants, int(quantIdx[c])), oldProg[c]), quantAdd(rfxGetQuant(quants, int(quantIdx[c])), prog[c]))
		// count srl/raw entries
		var rawVals []uint16
		var srlVals []int16
		var srlPos []int // band-offset positions of srl entries, in order
		maxRaw := func(nb uint8) uint16 { return uint16((1 << nb) - 1) }
		for _, b := range pdUpgradeBands {
			n := int(b.get(&nb))
			if n < 1 {
				continue
			}
			for i := 0; i < b.length; i++ {
				if !b.nonLL {
					rawVals = append(rawVals, uint16(gs.rng.Intn(1<<n)))
				} else if signs[c][b.off+i] == 0 {
					mx := int((1 << n) - 1)
					srlVals = append(srlVals, int16(gs.rng.Intn(2*mx+1)-mx))
					srlPos = append(srlPos, b.off+i)
				} else {
					rawVals = append(rawVals, uint16(gs.rng.Intn(int(maxRaw(uint8(n)))+1)))
				}
			}
		}
		srlData, rawData := pdEncodeUpgradeComponent(signs[c], rawVals, srlVals, nb)
		datas[c*2] = srlData
		datas[c*2+1] = rawData
		// Mirror the decoder: sign==0 positions take the SRL-decoded value as
		// their new sign for the next upgrade pass.
		for j, pos := range srlPos {
			signs[c][pos] = srlVals[j]
		}
	}
	block := pdTileUpgrade(xIdx, yIdx, quantIdx, uint8(newIdx), datas[0], datas[1], datas[2], datas[3], datas[4], datas[5])
	gs.tileProg[key] = newIdx
	return pdTileOut{xIdx: xIdx, yIdx: yIdx, block: block}
}

// pdRectForTiles returns the bounding rect of a tile set clipped to surface.
func pdRectForTiles(tiles []pdTileOut, w, h int) [4]uint16 {
	minX, minY := w, h
	maxX, maxY := 0, 0
	for _, t := range tiles {
		x := int(t.xIdx) * 64
		y := int(t.yIdx) * 64
		if x < minX {
			minX = x
		}
		if y < minY {
			minY = y
		}
		xe := x + 64
		if xe > w {
			xe = w
		}
		ye := y + 64
		if ye > h {
			ye = h
		}
		if xe > maxX {
			maxX = xe
		}
		if ye > maxY {
			maxY = ye
		}
	}
	return [4]uint16{uint16(minX), uint16(minY), uint16(maxX - minX), uint16(maxY - minY)}
}

type pdCase struct {
	name     string
	w, h     int
	payloads [][]byte
}

func pdBaseQuant(rng *rand.Rand) rfxQuant {
	v := func() uint8 { return uint8(6 + rng.Intn(3)) } // 6..8
	return rfxQuant{LL3: v(), HL3: v(), LH3: v(), HH3: v(), HL2: v(), LH2: v(), HH2: v(), HL1: v(), LH1: v(), HH1: v()}
}

// pdLadder builds a progressive-quant ladder strictly decreasing per band.
func pdLadder(rng *rand.Rand, steps int) []progressiveQuant {
	mk := func(scale int) rfxQuant {
		v := func() uint8 { return uint8(rng.Intn(scale + 1)) }
		return rfxQuant{LL3: v(), HL3: v(), LH3: v(), HH3: v(), HL2: v(), LH2: v(), HH2: v(), HL1: v(), LH1: v(), HH1: v()}
	}
	out := make([]progressiveQuant, steps)
	prev := [3]rfxQuant{mk(5), mk(5), mk(5)}
	for i := 0; i < steps; i++ {
		dec := func(q rfxQuant, p rfxQuant) rfxQuant {
			d := func(a, b uint8) uint8 {
				if a > b {
					return b
				}
				return a
			}
			return rfxQuant{LL3: d(q.LL3, p.LL3), HL3: d(q.HL3, p.HL3), LH3: d(q.LH3, p.LH3), HH3: d(q.HH3, p.HH3),
				HL2: d(q.HL2, p.HL2), LH2: d(q.LH2, p.LH2), HH2: d(q.HH2, p.HH2),
				HL1: d(q.HL1, p.HL1), LH1: d(q.LH1, p.LH1), HH1: d(q.HH1, p.HH1)}
		}
		cur := [3]rfxQuant{dec(prev[0], mk(5)), dec(prev[1], mk(5)), dec(prev[2], mk(5))}
		out[i] = progressiveQuant{quality: uint8(50 + i*10), y: cur[0], cb: cur[1], cr: cur[2]}
		prev = cur
	}
	return out
}

func pdGenCases() []pdCase {
	var cases []pdCase

	// Case 1: single SIMPLE tile, dense, no extrapolate
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(11)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}}
		t := pdEmitFirst(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, -1, nil, "dense")
		region := pdRegionBlock([][4]uint16{pdRectForTiles([]pdTileOut{t}, 64, 64)}, q, nil, 0, [][]byte{t.block})
		cases = append(cases, pdCase{"simple_dense", 64, 64, [][]byte{pdFrame(1, rfxSubbandDiffing, region)}})
	}
	// Case 2: single SIMPLE tile, dense, extrapolate
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(12)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}}
		t := pdEmitFirst(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, -1, nil, "dense")
		region := pdRegionBlock([][4]uint16{pdRectForTiles([]pdTileOut{t}, 64, 64)}, q, nil, rfxDWTReduceExtrapolate, [][]byte{t.block})
		cases = append(cases, pdCase{"simple_dense_extrapolate", 64, 64, [][]byte{pdFrame(1, rfxSubbandDiffing, region)}})
	}
	// Case 3: 3x2 tiles FIRST, sparse, subband-diffing context flag set
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(13)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{pdBaseQuant(gs.rng), pdBaseQuant(gs.rng)}
		ladder := pdLadder(gs.rng, 3)
		var tiles []pdTileOut
		for ty := 0; ty < 2; ty++ {
			for tx := 0; tx < 3; tx++ {
				tiles = append(tiles, pdEmitFirst(&gs, uint16(tx), uint16(ty), [3]uint8{uint8(tx % 2), 0, uint8(ty % 2)}, 0, gs.rng.Intn(3), ladder, "sparse"))
			}
		}
		blocks := make([][]byte, 0, len(tiles))
		for _, t := range tiles {
			blocks = append(blocks, t.block)
		}
		region := pdRegionBlock([][4]uint16{pdRectForTiles(tiles, 192, 128)}, q, ladder, 0, blocks)
		cases = append(cases, pdCase{"first_sparse_6tiles", 192, 128, [][]byte{pdFrame(1, rfxSubbandDiffing, region)}})
	}
	// Case 4: FIRST then two UPGRADE passes (serial path), extrapolate off
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(14)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{7, 7, 7, 7, 7, 7, 7, 7, 7, 7}}
		ladder := pdLadder(gs.rng, 4)
		var frames [][]byte
		var firstTiles []pdTileOut
		for ty := 0; ty < 2; ty++ {
			for tx := 0; tx < 3; tx++ {
				firstTiles = append(firstTiles, pdEmitFirst(&gs, uint16(tx), uint16(ty), [3]uint8{0, 0, 0}, 0, 0, ladder, "mixed"))
			}
		}
		blocks := make([][]byte, 0, len(firstTiles))
		for _, t := range firstTiles {
			blocks = append(blocks, t.block)
		}
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(firstTiles, 192, 128)}, q, ladder, 0, blocks)))
		for pass := 1; pass <= 2; pass++ {
			var ups []pdTileOut
			for _, t := range firstTiles {
				ups = append(ups, pdEmitUpgrade(&gs, t.xIdx, t.yIdx, [3]uint8{0, 0, 0}, pass, q, ladder))
			}
			ub := make([][]byte, 0, len(ups))
			for _, u := range ups {
				ub = append(ub, u.block)
			}
			frames = append(frames, pdFrame(uint32(pass+1), rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(ups, 192, 128)}, q, ladder, 0, ub)))
		}
		cases = append(cases, pdCase{"first_upgrade_x2", 192, 128, frames})
	}
	// Case 5: same but extrapolate on, non-aligned surface 200x130
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(15)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		w, h := 200, 130
		q := []rfxQuant{{8, 8, 8, 8, 8, 8, 8, 8, 8, 8}}
		ladder := pdLadder(gs.rng, 3)
		var frames [][]byte
		var firstTiles []pdTileOut
		for ty := 0; ty < 3; ty++ {
			for tx := 0; tx < 4; tx++ {
				firstTiles = append(firstTiles, pdEmitFirst(&gs, uint16(tx), uint16(ty), [3]uint8{0, 0, 0}, 0, 0, ladder, "mixed"))
			}
		}
		blocks := make([][]byte, 0, len(firstTiles))
		for _, t := range firstTiles {
			blocks = append(blocks, t.block)
		}
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(firstTiles, w, h)}, q, ladder, rfxDWTReduceExtrapolate, blocks)))
		var ups []pdTileOut
		for _, t := range firstTiles {
			ups = append(ups, pdEmitUpgrade(&gs, t.xIdx, t.yIdx, [3]uint8{0, 0, 0}, 1, q, ladder))
		}
		ub := make([][]byte, 0, len(ups))
		for _, u := range ups {
			ub = append(ub, u.block)
		}
		frames = append(frames, pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(ups, w, h)}, q, ladder, rfxDWTReduceExtrapolate, ub)))
		cases = append(cases, pdCase{"extrapolate_nonaligned_upgrade", w, h, frames})
	}
	// Case 6: coeffDiff sequence FIRST -> FIRST(diff) -> UPGRADE
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(16)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 7, 6, 7, 6, 7, 6, 7, 6, 7}}
		ladder := pdLadder(gs.rng, 3)
		var frames [][]byte
		var tiles1 []pdTileOut
		for ty := 0; ty < 2; ty++ {
			for tx := 0; tx < 2; tx++ {
				tiles1 = append(tiles1, pdEmitFirst(&gs, uint16(tx), uint16(ty), [3]uint8{0, 0, 0}, 0, 0, ladder, "mixed"))
			}
		}
		b1 := make([][]byte, 0, len(tiles1))
		for _, t := range tiles1 {
			b1 = append(b1, t.block)
		}
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(tiles1, 128, 128)}, q, ladder, 0, b1)))
		var tiles2 []pdTileOut
		for _, t := range tiles1 {
			tiles2 = append(tiles2, pdEmitFirst(&gs, t.xIdx, t.yIdx, [3]uint8{0, 0, 0}, rfxTileDifference, 1, ladder, "sparse"))
		}
		b2 := make([][]byte, 0, len(tiles2))
		for _, t := range tiles2 {
			b2 = append(b2, t.block)
		}
		frames = append(frames, pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(tiles2, 128, 128)}, q, ladder, 0, b2)))
		var ups []pdTileOut
		for _, t := range tiles1 {
			ups = append(ups, pdEmitUpgrade(&gs, t.xIdx, t.yIdx, [3]uint8{0, 0, 0}, 2, q, ladder))
		}
		ub := make([][]byte, 0, len(ups))
		for _, u := range ups {
			ub = append(ub, u.block)
		}
		frames = append(frames, pdFrame(3, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(ups, 128, 128)}, q, ladder, 0, ub)))
		cases = append(cases, pdCase{"coeffdiff_then_upgrade", 128, 128, frames})
	}
	// Case 7: extreme values SIMPLE tile
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(17)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{15, 15, 15, 15, 15, 15, 15, 15, 15, 15}}
		t := pdEmitFirst(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, -1, nil, "extreme")
		region := pdRegionBlock([][4]uint16{pdRectForTiles([]pdTileOut{t}, 64, 64)}, q, nil, 0, [][]byte{t.block})
		cases = append(cases, pdCase{"simple_extreme", 64, 64, [][]byte{pdFrame(1, rfxSubbandDiffing, region)}})
	}
	// Case 8: 16 tiles parallel path, mixed SIMPLE+FIRST, then UPGRADE all
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(18)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{pdBaseQuant(gs.rng)}
		ladder := pdLadder(gs.rng, 2)
		var frames [][]byte
		var tiles []pdTileOut
		for ty := 0; ty < 4; ty++ {
			for tx := 0; tx < 4; tx++ {
				qi := -1
				if (tx+ty)%2 == 0 {
					qi = 0
				}
				tiles = append(tiles, pdEmitFirst(&gs, uint16(tx), uint16(ty), [3]uint8{0, 0, 0}, 0, qi, ladder, "mixed"))
			}
		}
		blocks := make([][]byte, 0, len(tiles))
		for _, t := range tiles {
			blocks = append(blocks, t.block)
		}
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(tiles, 256, 256)}, q, ladder, 0, blocks)))
		var ups []pdTileOut
		for _, t := range tiles {
			if gs.tileProg[uint32(t.yIdx)<<16|uint32(t.xIdx)] >= 0 {
				ups = append(ups, pdEmitUpgrade(&gs, t.xIdx, t.yIdx, [3]uint8{0, 0, 0}, 1, q, ladder))
			}
		}
		ub := make([][]byte, 0, len(ups))
		for _, u := range ups {
			ub = append(ub, u.block)
		}
		frames = append(frames, pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(ups, 256, 256)}, q, ladder, 0, ub)))
		cases = append(cases, pdCase{"parallel_mixed", 256, 256, frames})
	}
	// Case 9: four-pass quality ladder on one tile
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(19)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}}
		ladder := pdLadder(gs.rng, 4)
		var frames [][]byte
		t0 := pdEmitFirst(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, 0, ladder, "dense")
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{t0.block})))
		for pass := 1; pass < 4; pass++ {
			u := pdEmitUpgrade(&gs, 0, 0, [3]uint8{0, 0, 0}, pass, q, ladder)
			frames = append(frames, pdFrame(uint32(pass+1), rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{u.block})))
		}
		cases = append(cases, pdCase{"multipass_ladder", 64, 64, frames})
	}
	// Case 10: upgrade after SIMPLE (numBits negative -> both must skip)
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(20)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}}
		ladder := pdLadder(gs.rng, 2)
		var frames [][]byte
		t0 := pdEmitFirst(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, -1, ladder, "mixed")
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{t0.block})))
		u := pdEmitUpgrade(&gs, 0, 0, [3]uint8{0, 0, 0}, 1, q, ladder)
		frames = append(frames, pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{u.block})))
		cases = append(cases, pdCase{"upgrade_after_simple_reject", 64, 64, frames})
	}
	// Case 11: portrait surface 130x200 with sparse content and upgrades
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(21)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		w, h := 130, 200
		q := []rfxQuant{pdBaseQuant(gs.rng)}
		ladder := pdLadder(gs.rng, 3)
		var frames [][]byte
		var tiles []pdTileOut
		for ty := 0; ty < 4; ty++ {
			for tx := 0; tx < 3; tx++ {
				if (tx*ty+tx)%3 == 0 {
					continue // leave holes: subset coverage
				}
				tiles = append(tiles, pdEmitFirst(&gs, uint16(tx), uint16(ty), [3]uint8{0, 0, 0}, 0, 0, ladder, "sparse"))
			}
		}
		blocks := make([][]byte, 0, len(tiles))
		for _, t := range tiles {
			blocks = append(blocks, t.block)
		}
		frames = append(frames, pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(tiles, w, h)}, q, ladder, 0, blocks)))
		var ups []pdTileOut
		for _, t := range tiles {
			ups = append(ups, pdEmitUpgrade(&gs, t.xIdx, t.yIdx, [3]uint8{0, 0, 0}, ladderIdxClamp(ladder, 2), q, ladder))
		}
		ub := make([][]byte, 0, len(ups))
		for _, u := range ups {
			ub = append(ub, u.block)
		}
		frames = append(frames, pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{pdRectForTiles(ups, w, h)}, q, ladder, 0, ub)))
		cases = append(cases, pdCase{"portrait_sparse_upgrade", w, h, frames})
	}
	// Case 12: minimal RAW-only upgrade. Every first-pass sign is positive.
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(111)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}}
		oneQ := rfxQuant{1, 1, 1, 1, 1, 1, 1, 1, 1, 1}
		ladder := []progressiveQuant{{quality: 50, y: oneQ, cb: oneQ, cr: oneQ}, {quality: 60}}
		one := make([]int16, 4096)
		for i := range one {
			one[i] = 1
		}
		comps := [3][]int16{append([]int16(nil), one...), append([]int16(nil), one...), append([]int16(nil), one...)}
		first := pdEmitFirstCoefs(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, 0, comps)
		up := pdEmitUpgrade(&gs, 0, 0, [3]uint8{0, 0, 0}, 1, q, ladder)
		p0 := pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{first.block}))
		p1 := pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{up.block}))
		cases = append(cases, pdCase{"upgrade_raw_only", 64, 64, [][]byte{p0, p1}})
	}
	// Case 13: minimal SRL-only upgrade. Every first-pass sign is zero.
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(112)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}}
		oneQ := rfxQuant{1, 1, 1, 1, 1, 1, 1, 1, 1, 1}
		ladder := []progressiveQuant{{quality: 50, y: oneQ, cb: oneQ, cr: oneQ}, {quality: 60}}
		zero := make([]int16, 4096)
		comps := [3][]int16{append([]int16(nil), zero...), append([]int16(nil), zero...), append([]int16(nil), zero...)}
		first := pdEmitFirstCoefs(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, 0, comps)
		up := pdEmitUpgrade(&gs, 0, 0, [3]uint8{0, 0, 0}, 1, q, ladder)
		p0 := pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{first.block}))
		p1 := pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{up.block}))
		cases = append(cases, pdCase{"upgrade_srl_only", 64, 64, [][]byte{p0, p1}})
	}
	// Case 15: mixed RAW/SRL with different numBits across bands.
	{
		gs := pdGenState{rng: rand.New(rand.NewSource(114)), tileProg: map[uint32]int{}, tileSign: map[uint32][3][]int16{}}
		q := []rfxQuant{{8, 8, 8, 8, 8, 8, 8, 8, 8, 8}}
		oldQ := rfxQuant{5, 4, 3, 2, 1, 5, 4, 3, 2, 1}
		ladder := []progressiveQuant{{quality: 50, y: oldQ, cb: oldQ, cr: oldQ}, {quality: 60}}
		mixed := make([]int16, 4096)
		for i := range mixed {
			mixed[i] = int16((i % 3) - 1)
		}
		comps := [3][]int16{append([]int16(nil), mixed...), append([]int16(nil), mixed...), append([]int16(nil), mixed...)}
		first := pdEmitFirstCoefs(&gs, 0, 0, [3]uint8{0, 0, 0}, 0, 0, comps)
		up := pdEmitUpgrade(&gs, 0, 0, [3]uint8{0, 0, 0}, 1, q, ladder)
		p0 := pdFrame(1, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{first.block}))
		p1 := pdFrame(2, rfxSubbandDiffing, pdRegionBlock([][4]uint16{{0, 0, 64, 64}}, q, ladder, 0, [][]byte{up.block}))
		cases = append(cases, pdCase{"upgrade_mixed_var_bits", 64, 64, [][]byte{p0, p1}})
	}
	return cases
}

func ladderIdxClamp(ladder []progressiveQuant, i int) int {
	if i >= len(ladder) {
		return len(ladder) - 1
	}
	return i
}

func pdWriteCase(dir string, idx int, c pdCase) error {
	cd := filepath.Join(dir, fmt.Sprintf("case%02d_%s", idx, c.name))
	if err := os.MkdirAll(cd, 0o755); err != nil {
		return err
	}
	meta := fmt.Sprintf("%d %d %d\n", c.w, c.h, len(c.payloads))
	if err := os.WriteFile(filepath.Join(cd, "meta.txt"), []byte(meta), 0o644); err != nil {
		return err
	}
	for i, p := range c.payloads {
		if err := os.WriteFile(filepath.Join(cd, fmt.Sprintf("payload.%02d.bin", i)), p, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Encoder self-tests (round-trip through the production decoders)
// ---------------------------------------------------------------------------

func TestPdRlgr1RoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 200; iter++ {
		n := 4096
		coefs := make([]int16, n)
		mode := iter % 4
		for i := range coefs {
			switch mode {
			case 0:
				if rng.Intn(100) < 90 {
					coefs[i] = 0
				} else {
					coefs[i] = int16(rng.Intn(201) - 100)
				}
			case 1:
				if rng.Intn(100) < 2 {
					coefs[i] = int16(rng.Intn(65536) - 32768)
				} else {
					coefs[i] = int16(rng.Intn(6001) - 3000)
				}
			case 2:
				coefs[i] = int16(rng.Intn(21) - 10)
			case 3:
				if i > n-50 {
					coefs[i] = 0
				} else if rng.Intn(100) < 2 {
					coefs[i] = int16(rng.Intn(65536) - 32768)
				} else {
					coefs[i] = int16(rng.Intn(4097) - 2048)
				}
			}
		}
		enc := pdRlgr1Encode(coefs)
		dec := rlgr1Decode(enc, n, nil)
		for i := 0; i < n; i++ {
			if dec[i] != coefs[i] {
				t.Fatalf("iter %d idx %d: got %d want %d", iter, i, dec[i], coefs[i])
			}
		}
	}
}

func TestPdSrlRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(8))
	for iter := 0; iter < 100; iter++ {
		var sign [4096]int16
		for i := range sign {
			sign[i] = int16(rng.Intn(3) - 1)
		}
		mkQ := func() rfxQuant {
			v := func() uint8 { return uint8(1 + rng.Intn(8)) }
			return rfxQuant{LL3: v(), HL3: v(), LH3: v(), HH3: v(), HL2: v(), LH2: v(), HH2: v(), HL1: v(), LH1: v(), HH1: v()}
		}
		nb := mkQ()
		// build raw/srl value lists
		var rawVals []uint16
		var srlVals []int16
		expected := make([]int32, 4096)
		for _, b := range pdUpgradeBands {
			n := int(b.get(&nb))
			for i := 0; i < b.length; i++ {
				if !b.nonLL {
					v := uint16(rng.Intn(1 << n))
					rawVals = append(rawVals, v)
					expected[b.off+i] = int32(v)
				} else if sign[b.off+i] == 0 {
					mx := (1 << n) - 1
					v := int16(rng.Intn(2*mx+1) - mx)
					srlVals = append(srlVals, v)
					expected[b.off+i] = int32(v)
				} else {
					v := uint16(rng.Intn(1 << n))
					rawVals = append(rawVals, v)
					if sign[b.off+i] > 0 {
						expected[b.off+i] = int32(v)
					} else {
						expected[b.off+i] = -int32(v)
					}
				}
			}
		}
		srlData, rawData := pdEncodeUpgradeComponent(sign[:], rawVals, srlVals, nb)
		// decode through the production upgrade path with shift=0
		current := make([]int16, 4096)
		signCopy := make([]int16, 4096)
		copy(signCopy, sign[:])
		zero := rfxQuant{}
		rfxUpgradeComponent(current, signCopy, zero, zero, nb, srlData, rawData, false)
		for i := 0; i < 4096; i++ {
			if int32(current[i]) != expected[i] {
				t.Fatalf("iter %d idx %d: got %d want %d", iter, i, current[i], expected[i])
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Harness entry
// ---------------------------------------------------------------------------

func TestProgDiff(t *testing.T) {
	dir := os.Getenv("PROGDIFF_DIR")
	if dir == "" {
		t.Skip("PROGDIFF_DIR not set")
	}
	switch os.Getenv("PROGDIFF_MODE") {
	case "gen":
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for i, c := range pdGenCases() {
			if err := pdWriteCase(dir, i, c); err != nil {
				t.Fatal(err)
			}
		}
		t.Logf("generated %d cases in %s", len(pdGenCases()), dir)
	case "go":
		entries, err := filepath.Glob(filepath.Join(dir, "case*"))
		if err != nil || len(entries) == 0 {
			t.Fatalf("no cases in %s", dir)
		}
		for _, cd := range entries {
			var w, h, n int
			mf, err := os.Open(filepath.Join(cd, "meta.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fscan(mf, &w, &h, &n); err != nil {
				mf.Close()
				t.Fatal(err)
			}
			mf.Close()
			surface := make([]byte, w*h*4)
			dec := newRfxProgressiveDecoder()
			for i := 0; i < n; i++ {
				payload, err := os.ReadFile(filepath.Join(cd, fmt.Sprintf("payload.%02d.bin", i)))
				if err != nil {
					t.Fatal(err)
				}
				dec.Decode(payload, surface, w, h)
				if err := os.WriteFile(filepath.Join(cd, fmt.Sprintf("go.%02d.raw", i)), surface, 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
	default:
		t.Skip("PROGDIFF_MODE not set")
	}
}
