package motion

import "testing"

func TestEngineBufferLayout(t *testing.T) {
	var e Engine
	e.Init(4)
	if len(e.Buffer()) != 4*BufferStride {
		t.Fatalf("buffer len = %d, want %d", len(e.Buffer()), 4*BufferStride)
	}
	e.Configure(1, 0.3, 1.0)
	e.AnimateTo(1, 50)
	e.Tick(1.0 / 60)
	b := e.Buffer()
	v, vel, act := b[1*BufferStride], b[1*BufferStride+1], b[1*BufferStride+2]
	if act != 1 {
		t.Errorf("active flag = %v, want 1", act)
	}
	if v <= 0 || v >= 50 {
		t.Errorf("value after one tick = %v, want in (0,50)", v)
	}
	if vel <= 0 {
		t.Errorf("velocity after one tick = %v, want > 0", vel)
	}
	// Other slots untouched.
	if b[0] != 0 || b[2] != 0 {
		t.Errorf("slot 0 buffer disturbed: %v %v", b[0], b[2])
	}
}

func TestEngineTickSleeps(t *testing.T) {
	var e Engine
	e.Init(2)
	e.Configure(0, 0.3, 1.0)
	e.AnimateTo(0, 10)
	for i := 0; i < 240; i++ {
		if e.Tick(1.0/60) == 0 && i > 2 {
			return // asleep
		}
	}
	t.Fatal("engine never went idle")
}

func TestEngineGuardsBadIDs(t *testing.T) {
	var e Engine
	e.Init(2)
	// None of these may panic.
	e.Configure(-1, 0.3, 1)
	e.Configure(99, 0.3, 1)
	e.AnimateTo(-1, 1)
	e.AnimateToDelayed(99, 1, 0.1)
	e.Flick(-1, 1, 1)
	e.SetValue(99, 1)
	e.Stop(-1)
	if e.Value(99) != 0 || e.Velocity(-1) != 0 || e.IsActive(99) {
		t.Error("out-of-range access leaked state")
	}
}

func TestEngineSetValueInstant(t *testing.T) {
	var e Engine
	e.Init(1)
	e.Configure(0, 0.5, 0.8)
	e.SetValue(0, 42)
	if e.Value(0) != 42 || e.IsActive(0) {
		t.Errorf("SetValue: value=%v active=%v", e.Value(0), e.IsActive(0))
	}
	if e.Buffer()[2] != 0 {
		t.Error("buffer active flag should be 0 after SetValue")
	}
}

func TestEngineDelayedCountsActive(t *testing.T) {
	var e Engine
	e.Init(1)
	e.Configure(0, 0.2, 1)
	e.AnimateToDelayed(0, 100, 0.05)
	if n := e.Tick(1.0 / 60); n != 1 {
		t.Errorf("delayed slot must count active, got %d", n)
	}
}

func TestEngineEpsilonConfigurable(t *testing.T) {
	var e Engine
	e.Init(1)
	e.PosEps, e.VelEps = 50, 1e9 // loose: settles as soon as it crosses halfway
	e.Configure(0, 0.5, 1.0)
	e.AnimateTo(0, 100)
	settled := false
	for i := 0; i < 120; i++ { // 2s
		e.Tick(1.0 / 60)
		if !e.IsActive(0) {
			settled = true
			break
		}
	}
	if !settled {
		t.Error("loose epsilons should settle a halfway-crossed spring")
	}
	// With default tight epsilons the same spring must still be running.
	var e2 Engine
	e2.Init(1)
	e2.Configure(0, 0.5, 1.0)
	e2.AnimateTo(0, 100)
	for i := 0; i < 12; i++ {
		e2.Tick(1.0 / 60)
	}
	if !e2.IsActive(0) {
		t.Error("tight epsilons must not settle a spring after 0.2s")
	}
}

func TestEngineReinit(t *testing.T) {
	var e Engine
	e.Init(2)
	e.AnimateTo(0, 5)
	e.Init(8) // reinit must reset everything
	if e.Capacity() != 8 {
		t.Fatalf("capacity = %d", e.Capacity())
	}
	if e.IsActive(0) || e.Tick(1.0/60) != 0 {
		t.Error("state leaked across Init")
	}
}
