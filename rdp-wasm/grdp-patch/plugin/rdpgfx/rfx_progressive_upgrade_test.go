package rdpgfx

import "testing"

// rfxBitWriter is a MSB-first bit writer used only in tests to synthesize
// SRL/RAW upgrade streams.
type rfxBitWriter struct {
	bytes  []byte
	bitPos int // number of bits written into the last partial byte
}

func (w *rfxBitWriter) writeBit(b uint16) {
	if w.bitPos == 0 {
		w.bytes = append(w.bytes, 0)
	}
	if b&1 != 0 {
		w.bytes[len(w.bytes)-1] |= 1 << (7 - uint(w.bitPos))
	}
	w.bitPos = (w.bitPos + 1) & 7
}

func (w *rfxBitWriter) writeBits(val uint16, n int) {
	for i := n - 1; i >= 0; i-- {
		w.writeBit((val >> uint(i)) & 1)
	}
}

// TestRfxBitReaderMSB verifies the bit reader consumes MSB-first, matching
// FreeRDP wBitStream on the SRL/RAW upgrade streams.
func TestRfxBitReaderMSB(t *testing.T) {
	// 0b10110000: bits MSB->LSB = 1,0,1,1,0,0,0,0
	r := &rfxBitReader{data: []byte{0b10110000}}
	if got := r.readBits(1); got != 1 {
		t.Fatalf("bit0 = %d, want 1", got)
	}
	if got := r.readBits(1); got != 0 {
		t.Fatalf("bit1 = %d, want 0", got)
	}
	if got := r.readBits(2); got != 0b11 {
		t.Fatalf("bits2-3 = %d, want 3", got)
	}
	if got := r.readBits(4); got != 0 {
		t.Fatalf("bits4-7 = %d, want 0", got)
	}
}

// TestRfxSrlReadZeroRun verifies the SRL '0'-bit zero-run consumes exactly
// (1<<k) zero coefficients (the off-by-one fix). We hand-build a stream that
// encodes a single '0' bit with the initial kp=8 (k=1) → run of 2 zeros,
// then a '1'-terminated non-zero coefficient.
func TestRfxSrlReadZeroRun(t *testing.T) {
	w := &rfxBitWriter{}
	// kp starts at 8 → k = 1.
	// Encode: '0'  => nz = (1<<1) = 2 zeros; kp -> 12.
	w.writeBit(0)
	// Next coefficient is non-zero: write '1' (nz < 2^k path). kp=12 → k=1.
	// We want nz=0 (no additional zeros), so write k=1 bits of value 0.
	w.writeBit(1)     // escape: nz < 2^k
	w.writeBits(0, 1) // nz = 0
	// unary magnitude: sign=0 (positive), magnitude: '1' terminates at mag=1.
	w.writeBit(0) // sign = 0 → +
	w.writeBit(1) // unary terminator → mag = 1

	st := newRfxSrlState(w.bytes, nil)
	st.nonLL = true
	// First read consumes the leading zero (returns 0), nz becomes 1.
	if got := rfxSrlRead(st, 1); got != 0 {
		t.Fatalf("read0 = %d, want 0", got)
	}
	// Second read consumes the second zero of the run, nz becomes 0.
	if got := rfxSrlRead(st, 1); got != 0 {
		t.Fatalf("read1 = %d, want 0", got)
	}
	// Third read hits the encoded non-zero coefficient: +1.
	if got := rfxSrlRead(st, 1); got != 1 {
		t.Fatalf("read2 = %d, want 1", got)
	}
}

// TestRfxUpgradeBlockRawLL verifies the LL3 (nonLL=false) path reads unsigned
// values from the RAW stream and accumulates them shifted.
func TestRfxUpgradeBlockRawLL(t *testing.T) {
	// numBits=3, three coefficients with raw values 5, 2, 7.
	w := &rfxBitWriter{}
	w.writeBits(5, 3)
	w.writeBits(2, 3)
	w.writeBits(7, 3)

	st := newRfxSrlState(nil, w.bytes)
	st.nonLL = false
	current := make([]int16, 3)
	sign := make([]int16, 3)
	// shift=1 → each value << 1 added.
	rfxUpgradeBlock(st, current, sign, 3, 1, 3)
	want := []int16{5 << 1, 2 << 1, 7 << 1}
	for i := range want {
		if current[i] != want[i] {
			t.Fatalf("current[%d] = %d, want %d", i, current[i], want[i])
		}
	}
}

// TestRfxUpgradeBlockSignRouting verifies the nonLL path routes positive/negative
// signed coefficients to RAW and zero (unknown-sign) coefficients to SRL.
func TestRfxUpgradeBlockSignRouting(t *testing.T) {
	// Three coefficients: sign>0, sign<0, sign==0.
	sraw := &rfxBitWriter{} // RAW stream (used for sign != 0)
	sraw.writeBits(4, 3)    // for sign>0: +4
	sraw.writeBits(2, 3)    // for sign<0: -2
	ssrl := &rfxBitWriter{} // SRL stream (used for sign == 0)
	// SRL for the zero-sign coeff: encode non-zero +3 with numBits=2.
	// kp=8 → k=1. Write '1' escape, nz=0 (k=1 bit), sign=0, unary: mag<3.
	ssrl.writeBit(1)     // escape (nz<2^k)
	ssrl.writeBits(0, 1) // nz=0
	ssrl.writeBit(0)     // sign=0 → +
	// numBits=2 → max=3. unary: write (mag-1) zeros then a 1. For mag=3:
	ssrl.writeBit(0) // mag=2
	ssrl.writeBit(1) // terminate → mag=3? see below

	st := newRfxSrlState(ssrl.bytes, sraw.bytes)
	st.nonLL = true
	current := make([]int16, 3)
	sign := []int16{1, -1, 0}
	rfxUpgradeBlock(st, current, sign, 3, 0, 3)
	// sign[0]>0 → +4 ; sign[1]<0 → -2 ; sign[2]==0 → SRL(+? )
	if current[0] != 4 {
		t.Fatalf("current[0] = %d, want 4", current[0])
	}
	if current[1] != -2 {
		t.Fatalf("current[1] = %d, want -2", current[1])
	}
	// third coefficient read from SRL; just assert sign got updated to non-zero.
	if sign[2] == 0 {
		t.Fatalf("sign[2] should be updated by SRL read, still 0")
	}
}

// TestRfxUpgradeComponentFullTile runs a full-tile upgrade through
// rfxUpgradeComponent with all-zero SRL/RAW (numBits=0 everywhere → no-op),
// asserting the coefficient buffer is unchanged and no panic occurs.
func TestRfxUpgradeComponentFullTile(t *testing.T) {
	var current, sign coeffArr
	for i := range current {
		current[i] = int16(i % 7)
		sign[i] = int16(i%3 - 1)
	}
	before := current
	zero := rfxQuant{}
	// numBits all zero → every rfxUpgradeBlock returns immediately.
	if !rfxUpgradeComponent(current[:], sign[:], zero, zero, zero, nil, nil, true) {
		t.Fatalf("zero-bit upgrade reported failure")
	}
	if current != before {
		t.Fatalf("current modified with numBits=0 upgrade")
	}
	if !rfxUpgradeComponent(current[:], sign[:], zero, zero, zero, nil, nil, false) {
		t.Fatalf("zero-bit non-extrapolate upgrade reported failure")
	}
	if current != before {
		t.Fatalf("current modified with numBits=0 upgrade (non-extrapolate)")
	}
}

func TestRfxBitReaderUnderflow(t *testing.T) {
	r := &rfxBitReader{}
	if got := r.readBits(1); got != 0 || !r.failed {
		t.Fatalf("underflow got=%d failed=%v, want 0/true", got, r.failed)
	}
}

func TestDecodeTileUpgradeQuantIncreaseIsAtomic(t *testing.T) {
	d := newRfxProgressiveDecoder()
	var y, cb, cr, ys, cbs, crs coeffArr
	for i := range y {
		y[i], cb[i], cr[i] = int16(i%11), int16(i%13), int16(i%17)
		ys[i], cbs[i], crs[i] = 1, -1, 1
	}
	oldBit := rfxQuant{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}
	tile := &rfxTileCoeffs{y: &y, cb: &cb, cr: &cr, ySign: &ys, cbSign: &cbs, crSign: &crs,
		yBit: oldBit, cbBit: oldBit, crBit: oldBit}
	d.tileCache[0] = tile
	beforeY, beforeCb, beforeCr := y, cb, cr
	beforeYS, beforeCbS, beforeCrS := ys, cbs, crs

	// Base 6 plus progressive HL1=1 makes target HL1=7, greater than the
	// cached 6. Upstream FreeRDP rejects the whole upgrade on any band increase.
	body := make([]byte, 20)
	base := rfxQuant{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}
	prog := []progressiveQuant{{y: rfxQuant{HL1: 1}, cb: rfxQuant{HL1: 1}, cr: rfxQuant{HL1: 1}}}
	d.decodeTileUpgrade(body, []rfxQuant{base}, prog, make([]byte, 64*64*4), 64, 64, false, true, false)

	if y != beforeY || cb != beforeCb || cr != beforeCr || ys != beforeYS || cbs != beforeCbS || crs != beforeCrS {
		t.Fatalf("quant-increasing upgrade partially modified tile cache")
	}
	if tile.yBit != oldBit || tile.cbBit != oldBit || tile.crBit != oldBit {
		t.Fatalf("quant-increasing upgrade advanced bit positions")
	}
}

func TestDecodeTileUpgradeTruncatedIsAtomic(t *testing.T) {
	d := newRfxProgressiveDecoder()
	var y, cb, cr, ys, cbs, crs coeffArr
	for i := range y {
		y[i], cb[i], cr[i] = int16(i%11), int16(i%13), int16(i%17)
		ys[i], cbs[i], crs[i] = 1, -1, 1
	}
	oldBit := rfxQuant{7, 7, 7, 7, 7, 7, 7, 7, 7, 7}
	tile := &rfxTileCoeffs{y: &y, cb: &cb, cr: &cr, ySign: &ys, cbSign: &cbs, crSign: &crs,
		yBit: oldBit, cbBit: oldBit, crBit: oldBit}
	d.tileCache[0] = tile
	beforeY, beforeCb, beforeCr := y, cb, cr
	beforeYS, beforeCbS, beforeCrS := ys, cbs, crs

	// q indices/x/y/quality and all six stream lengths are zero. With base
	// quant 6 and cached bit position 7 this requests one bit per band from
	// empty RAW/SRL streams and must reject the whole tile.
	body := make([]byte, 20)
	base := rfxQuant{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}
	d.decodeTileUpgrade(body, []rfxQuant{base}, []progressiveQuant{{}}, make([]byte, 64*64*4), 64, 64, false, true, false)

	if y != beforeY || cb != beforeCb || cr != beforeCr || ys != beforeYS || cbs != beforeCbS || crs != beforeCrS {
		t.Fatalf("truncated upgrade partially modified tile cache")
	}
	if tile.yBit != oldBit || tile.cbBit != oldBit || tile.crBit != oldBit {
		t.Fatalf("truncated upgrade advanced bit positions")
	}
}
