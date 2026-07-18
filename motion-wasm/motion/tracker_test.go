package motion

import (
	"math"
	"testing"
)

func TestTrackerLinearVelocity(t *testing.T) {
	var tr Tracker
	// Perfect linear motion at 1000 px/s in x, 0 in y.
	for i := 0; i <= 8; i++ {
		tm := float64(i) * 0.016
		tr.Push(tm, 1000*tm, 0)
	}
	vx, vy := tr.Velocity()
	if math.Abs(vx-1000) > 1e-6 {
		t.Errorf("vx = %v, want 1000", vx)
	}
	if math.Abs(vy) > 1e-6 {
		t.Errorf("vy = %v, want 0", vy)
	}
}

func TestTrackerFollowsRecentWindow(t *testing.T) {
	var tr Tracker
	// Fast (10000 px/s) until t=0.1, then slow (100 px/s).
	for i := 0; i <= 12; i++ {
		tm := float64(i) * 0.0167
		var x float64
		if tm <= 0.1 {
			x = 10000 * tm
		} else {
			x = 10000*0.1 + 100*(tm-0.1)
		}
		tr.Push(tm, x, 0)
	}
	vx, _ := tr.Velocity()
	if math.Abs(vx-100) > 30 {
		t.Errorf("vx = %v, want ≈100 (recent window should dominate)", vx)
	}
}

func TestTrackerInsufficientSamples(t *testing.T) {
	var tr Tracker
	if vx, vy := tr.Velocity(); vx != 0 || vy != 0 {
		t.Error("empty tracker must return 0,0")
	}
	tr.Push(0.1, 50, 50)
	if vx, vy := tr.Velocity(); vx != 0 || vy != 0 {
		t.Error("single sample must return 0,0")
	}
}

func TestTrackerClear(t *testing.T) {
	var tr Tracker
	for i := 0; i <= 4; i++ {
		tr.Push(float64(i)*0.016, float64(i)*16, 0)
	}
	tr.Clear()
	if vx, _ := tr.Velocity(); vx != 0 {
		t.Errorf("after clear vx=%v", vx)
	}
}

func TestTrackerRingOverwrite(t *testing.T) {
	var tr Tracker
	// Push more than capacity; oldest must drop out.
	for i := 0; i < TrackerSamples+8; i++ {
		tm := float64(i) * 0.016
		tr.Push(tm, 500*tm, 2*tm)
	}
	vx, vy := tr.Velocity()
	if math.Abs(vx-500) > 1e-6 || math.Abs(vy-2) > 1e-6 {
		t.Errorf("ring overwrite broke fit: vx=%v vy=%v", vx, vy)
	}
}

func TestTrackerNoisyLinear(t *testing.T) {
	var tr Tracker
	// 800 px/s with ±3px jitter: fit should stay near 800.
	jitter := []float64{2.1, -1.4, 3.0, -2.6, 1.2, -0.8, 2.9, -2.2, 0.5}
	for i := 0; i <= 8; i++ {
		tm := float64(i) * 0.016
		tr.Push(tm, 800*tm+jitter[i], 0)
	}
	vx, _ := tr.Velocity()
	if math.Abs(vx-800) > 120 {
		t.Errorf("noisy fit vx=%v too far from 800", vx)
	}
}

func TestProjectExact(t *testing.T) {
	// (500/1000) * 0.998 / 0.002 = 249.5
	if got := Project(500, 0.998); math.Abs(got-249.5) > 1e-9 {
		t.Errorf("Project(500, .998) = %v, want 249.5", got)
	}
	if Project(500, 0) != 0 || Project(500, 1) != 0 {
		t.Error("invalid decel rates must return 0")
	}
	if Project(0, 0.998) != 0 {
		t.Error("zero velocity must project zero")
	}
	// Direction preserved.
	if got := Project(-500, 0.998); math.Abs(got+249.5) > 1e-9 {
		t.Errorf("negative velocity must project negative, got %v", got)
	}
}

func TestRubberbandProperties(t *testing.T) {
	if Rubberband(0, 100, 0.55) != 0 {
		t.Error("f(0) must be 0")
	}
	prev := 0.0
	for o := 1.0; o <= 500; o += 1 {
		v := Rubberband(o, 100, 0.55)
		if v <= prev {
			t.Fatalf("not monotonic at %v: %v <= %v", o, v, prev)
		}
		if v >= 100 {
			t.Fatalf("must stay below dimension, got %v at %v", v, o)
		}
		prev = v
	}
	// Odd symmetry.
	if Rubberband(-25, 100, 0.55) != -Rubberband(25, 100, 0.55) {
		t.Error("must be odd-symmetric")
	}
	// Approaches dimension asymptotically.
	if v := Rubberband(1e6, 100, 0.55); v < 99 || v >= 100 {
		t.Errorf("asymptote: %v", v)
	}
}

func TestRubberbandClamp(t *testing.T) {
	if v := RubberbandClamp(50, 0, 100, 100, 0.55); v != 50 {
		t.Errorf("inside range must pass through, got %v", v)
	}
	if v := RubberbandClamp(150, 0, 100, 100, 0.55); v <= 100 || v >= 200 {
		t.Errorf("past max must be resisted, got %v", v)
	}
	if v := RubberbandClamp(-50, 0, 100, 100, 0.55); v >= 0 || v <= -100 {
		t.Errorf("past min must be resisted, got %v", v)
	}
}
