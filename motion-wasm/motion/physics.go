package motion

import "math"

// DefaultDecelRate matches iOS scroll deceleration (normal feel).
const DefaultDecelRate = 0.998

// DefaultRubberbandConstant is Apple's boundary damping constant.
const DefaultRubberbandConstant = 0.55

// Project returns the distance a gesture will travel past its release point
// under exponential decay — the exact projection Apple ships in the
// Designing Fluid Interfaces sample code:
//
//	(v / 1000) * rate / (1 - rate)
//
// velocity in px/s, rate per-millisecond decay (0.998 normal, 0.99 snappy).
// NOTE: the textbook v^2/(2a) form is NOT what iOS does; use this one.
func Project(velocity, decelRate float64) float64 {
	if decelRate <= 0 || decelRate >= 1 {
		return 0
	}
	return (velocity / 1000) * decelRate / (1 - decelRate)
}

// ProjectEndpoint is a convenience: release position + projection.
func ProjectEndpoint(position, velocity, decelRate float64) float64 {
	return position + Project(velocity, decelRate)
}

// Rubberband applies progressive resistance to an overshoot past a boundary:
//
//	(overshoot * dimension * c) / (dimension + c * |overshoot|)
//
// Sign-preserving, f(0)=0, asymptotic to ±dimension as overshoot→∞.
// The further past the edge, the less the element follows — "responsive,
// but there's nothing more here" instead of a hard stop.
func Rubberband(overshoot, dimension, constant float64) float64 {
	if constant <= 0 {
		constant = DefaultRubberbandConstant
	}
	if dimension <= 0 {
		return overshoot
	}
	d := math.Abs(overshoot)
	return math.Copysign((d*dimension*constant)/(dimension+constant*d), overshoot)
}

// RubberbandClamp applies Rubberband to the part of value that exceeds
// [min, max]; values inside the range pass through untouched.
func RubberbandClamp(value, min, max, dimension, constant float64) float64 {
	if value < min {
		return min + Rubberband(value-min, dimension, constant)
	}
	if value > max {
		return max + Rubberband(value-max, dimension, constant)
	}
	return value
}
