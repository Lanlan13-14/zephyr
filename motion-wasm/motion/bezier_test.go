package motion

import (
	"math"
	"testing"
)

func TestBezierEndpoints(t *testing.T) {
	curves := [][4]float64{
		{0.25, 0.1, 0.25, 1},   // CSS ease
		{0.16, 1, 0.3, 1},      // strong ease-out
		{0.32, 0.72, 0, 1},     // iOS drawer
		{0.77, 0, 0.175, 1},    // ease-in-out
		{0, 0, 1, 1},           // linear
	}
	for _, c := range curves {
		if y := CubicBezierSample(c[0], c[1], c[2], c[3], 0); y != 0 {
			t.Errorf("%v: f(0)=%v", c, y)
		}
		if y := CubicBezierSample(c[0], c[1], c[2], c[3], 1); y != 1 {
			t.Errorf("%v: f(1)=%v", c, y)
		}
	}
}

func TestBezierKnownValues(t *testing.T) {
	// CSS ease midpoint is a well-known constant.
	if y := CubicBezierSample(0.25, 0.1, 0.25, 1, 0.5); math.Abs(y-0.802403) > 1e-3 {
		t.Errorf("ease(0.5) = %v, want ≈0.802403", y)
	}
	// Linear must be identity.
	for _, x := range []float64{0.1, 0.3, 0.5, 0.7, 0.9} {
		if y := CubicBezierSample(0, 0, 1, 1, x); math.Abs(y-x) > 1e-4 {
			t.Errorf("linear(%v) = %v", x, y)
		}
	}
	// Ease-out (0.16,1,0.3,1): fast start — at x=0.2 well past linear.
	if y := CubicBezierSample(0.16, 1, 0.3, 1, 0.2); y < 0.5 {
		t.Errorf("ease-out(0.2) = %v, want > 0.5", y)
	}
}

func TestBezierMonotonicForUIEase(t *testing.T) {
	prev := 0.0
	for i := 1; i <= 100; i++ {
		x := float64(i) / 100
		y := CubicBezierSample(0.16, 1, 0.3, 1, x)
		if y < prev {
			t.Fatalf("not monotonic at %v: %v < %v", x, y, prev)
		}
		prev = y
	}
}
