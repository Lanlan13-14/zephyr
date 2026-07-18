package motion

import "math"

// CubicBezierSample evaluates a CSS-style cubic-bezier(x1,y1,x2,y2) easing:
// given x in [0,1] (time fraction) it returns the eased y. This is the
// fallback for the few motions that are legitimately NOT springs (spinners,
// indeterminate bars, mirrored reversible transitions).
//
// Solve t for x(t)=x via Newton–Raphson, bisection on fallback — the
// standard approach used by WebKit/Gecko.
func CubicBezierSample(x1, y1, x2, y2, x float64) float64 {
	if x <= 0 {
		return 0
	}
	if x >= 1 {
		return 1
	}
	// Bezier endpoints are (0,0) and (1,1) for CSS easings.
	t := x // good initial guess: x(t) is monotonic for sane control points
	for i := 0; i < 8; i++ {
		cx := bez(t, x1, x2) - x
		if math.Abs(cx) < 1e-6 {
			return bez(t, y1, y2)
		}
		d := bezDeriv(t, x1, x2)
		if math.Abs(d) < 1e-6 {
			break
		}
		t -= cx / d
	}
	// Bisection fallback.
	lo, hi := 0.0, 1.0
	t = x
	for i := 0; i < 40; i++ {
		cx := bez(t, x1, x2) - x
		if math.Abs(cx) < 1e-6 {
			break
		}
		if cx > 0 {
			hi = t
		} else {
			lo = t
		}
		t = (lo + hi) / 2
	}
	return bez(t, y1, y2)
}

// bez evaluates one axis of a cubic bezier with endpoints 0 and 1.
func bez(t, p1, p2 float64) float64 {
	u := 1 - t
	return 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t
}

func bezDeriv(t, p1, p2 float64) float64 {
	u := 1 - t
	return 3*u*u*p1 + 6*u*t*(p2-p1) + 3*t*t*(1-p2)
}
