package motion

// Engine owns a fixed pool of spring slots plus a shared float64 buffer the
// host reads each frame. Buffer layout per slot (stride 3):
//
//	[ value, velocity, active(1|0) ]
//
// The wasm build exposes the buffer pointer/length so JS maps it as a
// Float64Array with zero copies per frame (same contract as the legacy
// zephyr-anim module).
const BufferStride = 3

const (
	DefaultPosEps = 0.01
	DefaultVelEps = 0.01
)

type Engine struct {
	slots  []Spring
	buffer []float64
	PosEps float64
	VelEps float64
}

// Init (re)creates the pool. All values start at 0, inactive.
func (e *Engine) Init(capacity int) {
	if capacity < 1 {
		capacity = 1
	}
	e.slots = make([]Spring, capacity)
	e.buffer = make([]float64, capacity*BufferStride)
	e.PosEps = DefaultPosEps
	e.VelEps = DefaultVelEps
}

func (e *Engine) Capacity() int { return len(e.slots) }

// Configure sets Apple parameters on a slot (preserving live value+velocity).
func (e *Engine) Configure(id int, response, damping float64) {
	if !e.ok(id) {
		return
	}
	e.slots[id].Configure(response, damping)
}

// AnimateTo retargets a slot, carrying velocity (interrupt-safe).
func (e *Engine) AnimateTo(id int, target float64) {
	if !e.ok(id) {
		return
	}
	e.slots[id].SetTarget(target)
}

// AnimateToDelayed retargets after delaySec (stagger).
func (e *Engine) AnimateToDelayed(id int, target, delaySec float64) {
	if !e.ok(id) {
		return
	}
	e.slots[id].SetTargetDelayed(target, delaySec)
}

// Flick retargets with an explicit initial velocity (gesture handoff).
func (e *Engine) Flick(id int, target, velocity float64) {
	if !e.ok(id) {
		return
	}
	e.slots[id].Flick(target, velocity)
}

// SetValue snaps a slot instantly (also the reduced-motion path).
func (e *Engine) SetValue(id int, value float64) {
	if !e.ok(id) {
		return
	}
	e.slots[id].Set(value)
	e.writeSlot(id)
}

func (e *Engine) Value(id int) float64 {
	if !e.ok(id) {
		return 0
	}
	return e.slots[id].Value
}

func (e *Engine) Velocity(id int) float64 {
	if !e.ok(id) {
		return 0
	}
	return e.slots[id].Velocity
}

func (e *Engine) IsActive(id int) bool {
	return e.ok(id) && e.slots[id].Active
}

func (e *Engine) Stop(id int) {
	if !e.ok(id) {
		return
	}
	e.slots[id].Stop()
	e.writeSlot(id)
}

// Tick advances every slot by dt and refreshes the shared buffer.
// Returns the number of slots still active (including delayed ones) so the
// host can sleep its rAF loop when the count hits zero.
func (e *Engine) Tick(dt float64) int {
	active := 0
	for i := range e.slots {
		s := &e.slots[i]
		if !s.Active {
			continue
		}
		s.Advance(dt)
		s.SnapIfSettled(e.PosEps, e.VelEps)
		e.writeSlot(i)
		if s.Active {
			active++
		}
	}
	return active
}

// Buffer returns the shared frame buffer (value/velocity/active per slot).
func (e *Engine) Buffer() []float64 { return e.buffer }

func (e *Engine) writeSlot(id int) {
	s := &e.slots[id]
	b := id * BufferStride
	e.buffer[b] = s.Value
	e.buffer[b+1] = s.Velocity
	if s.Active {
		e.buffer[b+2] = 1
	} else {
		e.buffer[b+2] = 0
	}
}

func (e *Engine) ok(id int) bool { return id >= 0 && id < len(e.slots) }
