// Package motion implements the physics core of the zephyr motion engine.
//
// The spring model uses Apple's parameterisation (WWDC 2018, Designing Fluid
// Interfaces): a spring is described by
//
//	response — how quickly the value approaches its target, in seconds
//	damping — damping ratio; 1.0 = critically damped (no overshoot),
//	          < 1.0 = underdamped (overshoot/oscillation)
//
// Mapping to the classic physics triplet (mass m = 1):
//
//	omega0 = 2*pi / response   (natural frequency)
//	k      = omega0^2          (stiffness)
//	c      = 2 * damping * omega0
//
// The solver is analytic (closed form), not integrated: given the segment
// start state (x0, v0) the value/velocity at any t is computed exactly and
// in O(1). This makes the engine deterministic, immune to frame-rate spikes,
// and trivially testable against golden vectors. The JS fallback solver
// (public/vendor/zephyr-motion/spring.js) implements the same math and is
// verified against the same vectors.
package motion

import "math"

const (
	// zetaEps delimits the critically-damped branch. Springs with
	// |damping-1| below this use the critical closed form; the under/over
	// branches are continuous through it, so the seam is invisible.
	zetaEps = 1e-9

	// minDamping keeps zeta > 0 so a spring always dissipates energy and
	// can settle (zeta == 0 would oscillate forever and never sleep).
	minDamping = 0.05

	// maxDT caps a single tick. Tab switches / long frames would otherwise
	// teleport values; clamping matches rAF-driven clients (Apple's
	// CADisplayLink behaves the same way after backgrounding).
	maxDT = 0.064
)

// Spring is one scalar channel: value + velocity moving toward a target.
//
// State is kept as a "segment": at every retarget/configure/tick we rebase
// (x0, v0, t=0) to the current (x, v), so the closed form always starts at
// t=0 and float error does not accumulate over long interactions.
type Spring struct {
	Omega  float64 // omega0 = 2*pi/response
	Zeta   float64 // damping ratio
	Target float64

	x0 float64 // value - Target at segment start
	v0 float64 // velocity at segment start
	t  float64 // elapsed seconds in current segment

	// Value/Velocity are the live, externally visible state.
	Value    float64
	Velocity float64

	Active bool
	Delay  float64 // seconds before activation (stagger support)

	// Instant springs (response <= 0) jump directly to target. Used for
	// reduced-motion parity inside the engine.
	Instant bool
}

// NewSpring builds a spring from Apple parameters. response <= 0 yields an
// instant spring. damping is clamped to [minDamping, ~].
func NewSpring(response, damping float64) Spring {
	s := Spring{}
	s.Configure(response, damping)
	return s
}

// Configure changes parameters without disturbing the current motion:
// value and velocity carry over (this is what makes re-parameterising an
// in-flight spring seamless).
func (s *Spring) Configure(response, damping float64) {
	if response <= 0 {
		s.Instant = true
		s.Omega, s.Zeta = 0, 1
		return
	}
	if damping < minDamping {
		damping = minDamping
	}
	s.Instant = false
	s.Omega = 2 * math.Pi / response
	s.Zeta = damping
}

// SetTarget retargets the spring, carrying the current velocity through.
// This is THE interruptibility primitive: nothing is recomputed from a
// logical start value, motion continues from the live (Value, Velocity).
func (s *Spring) SetTarget(target float64) {
	s.rebase(target)
	if s.Instant {
		s.Value, s.Velocity = target, 0
		s.Active = false
		return
	}
	s.Active = true
}

// SetTargetDelayed retargets after delay seconds (stagger). The current
// value is held during the delay; velocity is reset so a delayed spring
// never jumps on activation.
func (s *Spring) SetTargetDelayed(target, delay float64) {
	if delay <= 0 {
		s.SetTarget(target)
		return
	}
	s.rebase(target)
	s.Velocity = 0
	s.v0 = 0
	s.Delay = delay
	s.Active = true // must keep the engine ticking
}

// Flick retargets with an explicit initial velocity (velocity handoff from
// a released gesture).
func (s *Spring) Flick(target, velocity float64) {
	s.rebase(target)
	s.Velocity = velocity
	s.v0 = velocity
	if s.Instant {
		s.Value, s.Velocity = target, 0
		s.Active = false
		return
	}
	s.Active = true
}

// Set snaps to a value and stops.
func (s *Spring) Set(value float64) {
	s.Value, s.Velocity = value, 0
	s.Target = value
	s.x0, s.v0, s.t = 0, 0, 0
	s.Active = false
	s.Delay = 0
}

// Stop freezes the spring at its current value.
func (s *Spring) Stop() {
	s.rebase(s.Value)
	s.Velocity = 0
	s.v0 = 0
	s.Active = false
	s.Delay = 0
}

// Advance moves time forward by dt (clamped to maxDT) and returns whether
// the spring is still active afterwards. Settling (snap to target) is
// decided by the caller-supplied epsilons via Engine; here we only move.
func (s *Spring) Advance(dt float64) (x, v float64) {
	if !s.Active {
		return s.Value, s.Velocity
	}
	if s.Delay > 0 {
		s.Delay -= dt
		if s.Delay > 0 {
			return s.Value, s.Velocity
		}
		// Activate: start the segment from the held value.
		s.x0, s.v0, s.t = s.Value-s.Target, 0, 0
		if s.Instant {
			s.Value, s.Velocity, s.Active = s.Target, 0, false
			return s.Value, s.Velocity
		}
	}
	if dt > maxDT {
		dt = maxDT
	}
	s.t += dt
	x, v = s.eval(s.t)
	s.Value, s.Velocity = x, v
	return x, v
}

// rebase ends the current segment (evaluating it with its OWN target) and
// starts a fresh one at t=0 against the NEW target. Order matters: the live
// (Value, Velocity) must be computed before Target changes, otherwise the
// segment offset x0 = Value - Target is garbage and the spring teleports.
func (s *Spring) rebase(newTarget float64) {
	if s.Active && s.Delay <= 0 && s.t > 0 {
		s.Value, s.Velocity = s.eval(s.t)
	}
	s.Target = newTarget
	s.x0 = s.Value - newTarget
	s.v0 = s.Velocity
	s.t = 0
	s.Delay = 0
}

// eval computes (value, velocity) at segment time t via the closed form of
// the damped harmonic oscillator.
func (s *Spring) eval(t float64) (x, v float64) {
	a := s.x0 // initial offset from target
	w := s.Omega
	z := s.Zeta

	if z < 1-zetaEps {
		// Underdamped: x = T + e^(-zwt) [a cos(wd t) + b sin(wd t)]
		wd := w * math.Sqrt(1-z*z)
		b := (s.v0 + z*w*a) / wd
		e := math.Exp(-z * w * t)
		cosT, sinT := math.Cos(wd*t), math.Sin(wd*t)
		x = s.Target + e*(a*cosT+b*sinT)
		// v = d/dt: -zw e(...)(...) + e(...)(-a wd sin + b wd cos)
		v = e*(-z*w)*(a*cosT+b*sinT) + e*wd*(b*cosT-a*sinT)
		return x, v
	}
	if z > 1+zetaEps {
		// Overdamped: x = T + c1 e^(r1 t) + c2 e^(r2 t)
		r := w * math.Sqrt(z*z-1)
		r1 := -z*w + r
		r2 := -z*w - r
		c2 := (s.v0 - r1*a) / (r2 - r1)
		c1 := a - c2
		e1, e2 := math.Exp(r1*t), math.Exp(r2*t)
		x = s.Target + c1*e1 + c2*e2
		v = c1*r1*e1 + c2*r2*e2
		return x, v
	}
	// Critically damped: x = T + (c1 + c2 t) e^(-w t)
	c1 := a
	c2 := s.v0 + w*a
	e := math.Exp(-w * t)
	x = s.Target + (c1+c2*t)*e
	v = (c2 - w*(c1+c2*t)) * e
	return x, v
}

// Settled reports whether the spring is within epsilons of its target.
// An inactive spring is settled by definition.
func (s *Spring) Settled(posEps, velEps float64) bool {
	if !s.Active || s.Delay > 0 {
		return false
	}
	return math.Abs(s.Value-s.Target) <= posEps && math.Abs(s.Velocity) <= velEps
}

// SnapIfSettled snaps a settled spring exactly onto its target and
// deactivates it. Returns true when it snapped.
func (s *Spring) SnapIfSettled(posEps, velEps float64) bool {
	if s.Settled(posEps, velEps) {
		s.Value, s.Velocity = s.Target, 0
		s.x0, s.v0, s.t = 0, 0, 0
		s.Active = false
		return true
	}
	return false
}
