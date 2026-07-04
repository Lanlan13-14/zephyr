package rdpgfx

import "sync"

// Buffer pools for RFX tile decoding to minimize allocations in the hot path.
// Each 64×64 tile needs 4096 int16 coefficients per component (Y, Cb, Cr)
// and several temporary buffers for the IDWT.

// coeffArr is the fixed-size coefficient array stored in the pool.
// Using a pointer to an array (*coeffArr) avoids interface-boxing allocations:
// a pointer fits in one word of the any interface, whereas a []int16 header
// (pointer + len + cap = 24 bytes) always requires a 24-byte heap box.
type coeffArr = [4096]int16

var coeffPool = sync.Pool{
	New: func() any { return new(coeffArr) },
}

// idwtBufs holds the temporary buffer for one rfxIDWT2DLevel call.
// The subbands (HL/LH/HH/LL) are read directly from the input buf without copying.
type idwtBufs struct {
	tmp []int16 // intermediate row-interleaved buffer; max 64×64 = 4096
}

var idwtBufPool = sync.Pool{
	New: func() any {
		return &idwtBufs{tmp: make([]int16, 4096)}
	},
}

// planeBufPool reuses byte slices for the per-component planes in decodePlanar.
// The plane size varies (w×h bytes), so the pool stores capacity-keyed slices;
// acquirePlaneBuf re-slices to exactly `size` when the capacity is sufficient.
var planeBufPool = sync.Pool{
	New: func() any { return []byte(nil) },
}

func acquirePlaneBuf(size int) []byte {
	b := planeBufPool.Get().([]byte)
	if cap(b) >= size {
		return b[:size]
	}
	return make([]byte, size)
}

func releasePlaneBuf(b []byte) {
	if b != nil {
		planeBufPool.Put(b[:cap(b)])
	}
}
