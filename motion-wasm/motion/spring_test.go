package motion

import (
	"math"
	"testing"
)

// frameAdvance steps a spring in fixed frames like an rAF client.
func frameAdvance(s *Spring, seconds float64) {
	dt := 1.0 / 60
	for t := 0.0; t < seconds; t += dt {
		s.Advance(dt)
		s.SnapIfSettled(DefaultPosEps, DefaultVelEps)
	}
}

func TestCriticalSpringClosedForm(t *testing.T) {
	// response=0.4, damping=1 → omega = 2π/0.4 ≈ 15.708
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)

	// Hand-computed from the critical closed form (see spring.go):
	// c1=-100, c2=-1570.7963, e^{-1.5708}=0.2078796
	x, v := s.eval(0.1)
	if math.Abs(x-46.5478) > 0.05 {
		t.Errorf("x(0.1) = %v, want ≈46.5478", x)
	}
	if math.Abs(v-512.84) > 0.5 {
		t.Errorf("v(0.1) = %v, want ≈512.84", v)
	}
}

func TestSpringSettlesExactly(t *testing.T) {
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	frameAdvance(&s, 2.0)
	if s.Active {
		t.Fatal("spring should settle within 2s")
	}
	if s.Value != 100 || s.Velocity != 0 {
		t.Errorf("after settle: value=%v velocity=%v, want exactly 100, 0", s.Value, s.Velocity)
	}
}

func TestSpringSettleTimeBounded(t *testing.T) {
	// A 100px ui-preset spring must settle in well under 1.5s.
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	dt := 1.0 / 60
	settleAt := -1.0
	for i := 0; i < 90; i++ { // 1.5s
		s.Advance(dt)
		if s.SnapIfSettled(DefaultPosEps, DefaultVelEps) {
			settleAt = float64(i) * dt
			break
		}
	}
	if settleAt < 0 {
		t.Fatal("did not settle in 1.5s")
	}
	if settleAt > 1.2 {
		t.Errorf("settled at %v s — suspiciously slow for response=0.4", settleAt)
	}
	t.Logf("settled at %.2fs", settleAt)
}

func TestUnderdampedOvershoots(t *testing.T) {
	s := NewSpring(0.4, 0.7)
	s.Set(0)
	s.SetTarget(100)
	dt := 1.0 / 240 // fine sampling to catch the peak
	peak := 0.0
	for i := 0; i < 240*2; i++ {
		s.Advance(dt)
		if s.Value > peak {
			peak = s.Value
		}
		s.SnapIfSettled(DefaultPosEps, DefaultVelEps)
	}
	if peak <= 100.5 {
		t.Errorf("underdamped spring should overshoot: peak=%v", peak)
	}
	if s.Active {
		t.Error("should still settle")
	}
}

func TestOverdampedNoOvershoot(t *testing.T) {
	s := NewSpring(0.4, 1.5)
	s.Set(0)
	s.SetTarget(100)
	dt := 1.0 / 240
	for i := 0; i < 240*3; i++ {
		s.Advance(dt)
		if s.Value > 100 {
			t.Fatalf("overdamped spring overshot: %v", s.Value)
		}
		s.SnapIfSettled(DefaultPosEps, DefaultVelEps)
	}
}

func TestRetargetCarriesVelocity(t *testing.T) {
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	frameAdvance(&s, 0.2)

	vBefore := s.Velocity
	xBefore := s.Value
	s.SetTarget(500) // user redirects mid-flight

	if s.Velocity != vBefore {
		t.Errorf("velocity discontinuity on retarget: %v → %v", vBefore, s.Velocity)
	}
	if s.Value != xBefore {
		t.Errorf("value jumped on retarget: %v → %v", xBefore, s.Value)
	}
	// The new segment's analytic velocity at t=0 must equal the carried
	// velocity exactly (a far new target legitimately accelerates hard over
	// the next frame, so instantaneous — not average — velocity is the
	// correct continuity invariant).
	if _, v0 := s.eval(0); math.Abs(v0-vBefore) > 1e-9 {
		t.Errorf("segment-start velocity %v != carried %v", v0, vBefore)
	}
}

func TestRetargetReversesSmoothly(t *testing.T) {
	// 0 → 100, at mid-flight reverse to 0: value must turn around without
	// a teleport, and end exactly at 0.
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	frameAdvance(&s, 0.25)
	mid := s.Value
	s.SetTarget(0)
	frameAdvance(&s, 2.0)
	if s.Active || s.Value != 0 {
		t.Errorf("after reverse: active=%v value=%v", s.Active, s.Value)
	}
	if mid <= 0 || mid >= 100 {
		t.Errorf("mid value %v out of expected range", mid)
	}
}

func TestFlickInitialVelocity(t *testing.T) {
	s := NewSpring(0.4, 1.0)
	s.Set(50)
	s.Flick(0, 400) // thrown away from target
	if s.Velocity != 400 {
		t.Fatalf("flick velocity = %v, want 400", s.Velocity)
	}
	// Must first keep moving in the throw direction…
	dt := 1.0 / 60
	x0 := s.Value
	s.Advance(dt)
	if s.Value <= x0 {
		t.Error("flick should continue in velocity direction initially")
	}
	// …then settle on the target.
	frameAdvance(&s, 2.5)
	if s.Active || s.Value != 0 {
		t.Errorf("flick did not settle: active=%v value=%v", s.Active, s.Value)
	}
}

func TestDelayHoldsThenStarts(t *testing.T) {
	s := NewSpring(0.3, 1.0)
	s.Set(0)
	s.SetTargetDelayed(100, 0.1)
	dt := 1.0 / 60
	s.Advance(dt) // ~0.017 < 0.1
	if s.Value != 0 {
		t.Errorf("value moved during delay: %v", s.Value)
	}
	if !s.Active {
		t.Error("delayed spring must stay active so the engine keeps ticking")
	}
	frameAdvance(&s, 2.0)
	if s.Active || s.Value != 100 {
		t.Errorf("after delay+motion: active=%v value=%v", s.Active, s.Value)
	}
}

func TestInstantSpring(t *testing.T) {
	s := NewSpring(0, 1) // response <= 0 → instant
	s.Set(12)
	s.SetTarget(34)
	if s.Value != 34 || s.Active {
		t.Errorf("instant spring: value=%v active=%v", s.Value, s.Active)
	}
}

func TestDampingClamped(t *testing.T) {
	s := NewSpring(0.4, 0) // would never dissipate; must clamp
	if s.Zeta < minDamping {
		t.Errorf("zeta=%v, want >= %v", s.Zeta, minDamping)
	}
	s.Set(0)
	s.SetTarget(1)
	// zeta=0.05, response=0.4 → decay envelope e^{-0.785t}; needs ~10s.
	frameAdvance(&s, 12)
	if s.Active {
		t.Error("clamped spring should still settle eventually")
	}
}

func TestConfigureKeepsMotion(t *testing.T) {
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	frameAdvance(&s, 0.2)
	x, v := s.Value, s.Velocity
	s.Configure(0.2, 0.8) // swap preset mid-flight
	if s.Value != x || s.Velocity != v {
		t.Errorf("configure disturbed state: (%v,%v) → (%v,%v)", x, v, s.Value, s.Velocity)
	}
	frameAdvance(&s, 2.0)
	if s.Active || s.Value != 100 {
		t.Errorf("reconfigured spring did not settle: active=%v value=%v", s.Active, s.Value)
	}
}

func TestStopFreezes(t *testing.T) {
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	frameAdvance(&s, 0.2)
	x := s.Value
	s.Stop()
	frameAdvance(&s, 0.5)
	if s.Value != x || s.Active {
		t.Errorf("after stop: value=%v (want %v) active=%v", s.Value, x, s.Active)
	}
}

func TestDTClamped(t *testing.T) {
	// A 10s dt (tab resume) must not explode: clamped to maxDT.
	s := NewSpring(0.4, 1.0)
	s.Set(0)
	s.SetTarget(100)
	x, _ := s.Advance(10.0)
	if math.Abs(x-100) > 100 || math.IsNaN(x) || math.IsInf(x, 0) {
		t.Errorf("clamped advance produced %v", x)
	}
	// Equivalent to one maxDT step:
	s2 := NewSpring(0.4, 1.0)
	s2.Set(0)
	s2.SetTarget(100)
	x2, _ := s2.Advance(maxDT)
	if x != x2 {
		t.Errorf("clamp mismatch: %v vs %v", x, x2)
	}
}

// TestBranchContinuityAtCritical verifies the under/over/critical closed
// forms agree through the zeta=1 seam (no visible pop when a preset crosses).
func TestBranchContinuityAtCritical(t *testing.T) {
	for _, z := range []float64{1 - 2*zetaEps, 1, 1 + 2*zetaEps} {
		s := NewSpring(0.4, z)
		s.Set(0)
		s.SetTarget(100)
		x, v := s.eval(0.3)
		ref := NewSpring(0.4, 1.0)
		ref.Set(0)
		ref.SetTarget(100)
		rx, rv := ref.eval(0.3)
		if math.Abs(x-rx) > 1e-3 || math.Abs(v-rv) > 1e-2 {
			t.Errorf("seam discontinuity at zeta=%v: (%v,%v) vs (%v,%v)", z, x, v, rx, rv)
		}
	}
}
