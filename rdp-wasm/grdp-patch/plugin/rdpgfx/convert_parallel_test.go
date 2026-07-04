package rdpgfx

import (
	"math/rand"
	"testing"
)

// TestParallelRowsCoverage verifies parallelRows invokes fn over contiguous,
// non-overlapping chunks that together cover [0,h) exactly once, for both the
// serial (small) and parallel (large) regimes.
func TestParallelRowsCoverage(t *testing.T) {
	for _, dim := range []struct{ w, h int }{
		{16, 16},     // tiny → serial
		{64, 64},     // small → serial
		{256, 256},   // at threshold → parallel
		{512, 300},   // parallel, height not divisible by worker count
		{1920, 1080}, // typical full-screen → parallel
		{8, 1},       // single row
		{8, 0},       // zero rows
	} {
		counts := make([]int32, dim.h)
		parallelRows(dim.w, dim.h, func(y0, y1 int) {
			for r := y0; r < y1; r++ {
				counts[r]++
			}
		})
		for r := 0; r < dim.h; r++ {
			if counts[r] != 1 {
				t.Fatalf("dim %dx%d: row %d visited %d times, want 1", dim.w, dim.h, r, counts[r])
			}
		}
	}
}

// serialI420ToBGRA is an independent reference implementation used to verify the
// parallelised i420ToBGRA output is identical regardless of how rows are split.
func serialI420ToBGRA(src *H264FrameI420) []byte {
	w, h := src.Width, src.Height
	out := make([]byte, w*h*4)
	for row := 0; row < h; row++ {
		yOff := row * src.YStride
		uOff := (row >> 1) * src.UStride
		vOff := (row >> 1) * src.VStride
		for col := 0; col < w; col++ {
			uv := col >> 1
			o := (row*w + col) * 4
			u := int(src.U[uOff+uv]) - 128
			v := int(src.V[vOff+uv]) - 128
			if src.FullRange {
				y := int(src.Y[yOff+col])
				out[o] = clampByte((256*y + 475*u + 128) >> 8)
				out[o+1] = clampByte((256*y - 48*u - 120*v + 128) >> 8)
				out[o+2] = clampByte((256*y + 403*v + 128) >> 8)
			} else {
				c := int(src.Y[yOff+col]) - 16
				out[o] = clampByte((298*c + 541*u + 128) >> 8)
				out[o+1] = clampByte((298*c - 55*u - 136*v + 128) >> 8)
				out[o+2] = clampByte((298*c + 459*v + 128) >> 8)
			}
			out[o+3] = 255
		}
	}
	return out
}

func makeI420(w, h int, fullRange bool, rng *rand.Rand) *H264FrameI420 {
	cw, ch := (w+1)/2, (h+1)/2
	f := &H264FrameI420{
		Y: make([]byte, w*h), U: make([]byte, cw*ch), V: make([]byte, cw*ch),
		YStride: w, UStride: cw, VStride: cw,
		Width: w, Height: h, FullRange: fullRange,
	}
	for i := range f.Y {
		f.Y[i] = byte(rng.Intn(256))
	}
	for i := range f.U {
		f.U[i] = byte(rng.Intn(256))
		f.V[i] = byte(rng.Intn(256))
	}
	return f
}

// TestI420ToBGRAParallelMatchesSerial checks that the parallelised conversion
// produces byte-identical output to the reference for both small (serial) and
// large (parallel) frames, in full- and limited-range modes.
func TestI420ToBGRAParallelMatchesSerial(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, dim := range []struct{ w, h int }{
		{64, 64},   // serial path
		{640, 480}, // parallel path
		{512, 511}, // parallel, odd height
	} {
		for _, fr := range []bool{false, true} {
			f := makeI420(dim.w, dim.h, fr, rng)
			got, pooled := i420ToBGRA(f)
			if got == nil {
				t.Fatalf("i420ToBGRA returned nil for %dx%d", dim.w, dim.h)
			}
			want := serialI420ToBGRA(f)
			if len(got) != len(want) {
				t.Fatalf("%dx%d fr=%v: len %d != %d", dim.w, dim.h, fr, len(got), len(want))
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("%dx%d fr=%v: byte %d = %d, want %d", dim.w, dim.h, fr, i, got[i], want[i])
				}
			}
			if pooled {
				releaseBitmapBuf(got)
			}
		}
	}
}

func BenchmarkI420ToBGRA1080p(b *testing.B) {
rng := rand.New(rand.NewSource(2))
f := makeI420(1920, 1080, false, rng)
b.SetBytes(int64(1920 * 1080 * 4))
b.ResetTimer()
for i := 0; i < b.N; i++ {
out, pooled := i420ToBGRA(f)
if pooled {
releaseBitmapBuf(out)
}
}
}

// serialCombineAVC444v2BGRA mirrors combineAVC444v2BGRA's exact indexing in a
// single serial loop, used to confirm the parallelised version is byte-identical
// regardless of how the rows are split across workers.
func serialCombineAVC444v2BGRA(yPlane []byte, yStride int, cachedU, cachedV []byte, uvStride int,
i420aux *H264FrameI420, fullRange bool, w, h int) []byte {
out := make([]byte, w*h*4)
halfW := w / 2
quarterW := w / 4
for row := 0; row < h; row++ {
yRowOff := row * yStride
uvRow := row >> 1
uvRowOff := uvRow * uvStride
auxYRowOff := row * i420aux.YStride
auxURowOff := uvRow * i420aux.UStride
auxVRowOff := uvRow * i420aux.VStride
outIdx := row * w * 4
for col := 0; col < w; col++ {
Y := yPlane[yRowOff+col]
var Cb, Cr byte
if col&1 == 1 {
k := col >> 1
Cb = i420aux.Y[auxYRowOff+k]
Cr = i420aux.Y[auxYRowOff+halfW+k]
} else if row&1 == 0 {
k := col >> 1
Cb = cachedU[uvRowOff+k]
Cr = cachedV[uvRowOff+k]
} else {
k := col >> 2
if col&2 == 0 {
Cb = i420aux.U[auxURowOff+k]
Cr = i420aux.U[auxURowOff+quarterW+k]
} else {
Cb = i420aux.V[auxVRowOff+k]
Cr = i420aux.V[auxVRowOff+quarterW+k]
}
}
u := int(Cb) - 128
v := int(Cr) - 128
if fullRange {
y := int(Y)
out[outIdx] = clampByte((256*y + 475*u + 128) >> 8)
out[outIdx+1] = clampByte((256*y - 48*u - 120*v + 128) >> 8)
out[outIdx+2] = clampByte((256*y + 403*v + 128) >> 8)
} else {
c := int(Y) - 16
out[outIdx] = clampByte((298*c + 541*u + 128) >> 8)
out[outIdx+1] = clampByte((298*c - 55*u - 136*v + 128) >> 8)
out[outIdx+2] = clampByte((298*c + 459*v + 128) >> 8)
}
out[outIdx+3] = 255
outIdx += 4
}
}
return out
}

func TestCombineAVC444v2BGRAParallelMatchesSerial(t *testing.T) {
rng := rand.New(rand.NewSource(3))
for _, dim := range []struct{ w, h int }{
{64, 64},   // serial path
{640, 480}, // parallel path
{512, 510}, // parallel, even dims
} {
w, h := dim.w, dim.h
uvStride := (w + 1) / 2
uvH := (h + 1) / 2
yPlane := make([]byte, w*h)
cachedU := make([]byte, uvStride*uvH)
cachedV := make([]byte, uvStride*uvH)
for i := range yPlane {
yPlane[i] = byte(rng.Intn(256))
}
for i := range cachedU {
cachedU[i] = byte(rng.Intn(256))
cachedV[i] = byte(rng.Intn(256))
}
aux := &H264FrameI420{
Y: make([]byte, w*h), U: make([]byte, uvStride*uvH), V: make([]byte, uvStride*uvH),
YStride: w, UStride: uvStride, VStride: uvStride, Width: w, Height: h,
}
for i := range aux.Y {
aux.Y[i] = byte(rng.Intn(256))
}
for i := range aux.U {
aux.U[i] = byte(rng.Intn(256))
aux.V[i] = byte(rng.Intn(256))
}
for _, fr := range []bool{false, true} {
got, pooled := combineAVC444v2BGRA(yPlane, w, cachedU, cachedV, uvStride, aux, fr, w, h, nil)
want := serialCombineAVC444v2BGRA(yPlane, w, cachedU, cachedV, uvStride, aux, fr, w, h)
for i := range want {
if got[i] != want[i] {
t.Fatalf("%dx%d fr=%v: byte %d = %d, want %d", w, h, fr, i, got[i], want[i])
}
}
if pooled {
releaseBitmapBuf(got)
}
}
}
}
