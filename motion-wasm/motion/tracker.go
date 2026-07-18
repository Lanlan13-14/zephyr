package motion

import "math"

// Tracker estimates pointer velocity (px/s) from a short history of
// timestamped positions — the input to velocity handoff (WWDC 2018 §5).
//
// Method: weighted least-squares slope over the samples inside a trailing
// window, with exponential recency weights (newer samples count more).
// Least squares beats finite differencing against jitter from touch
// digitizers; the window bounds the lag so direction changes register fast.
const (
	TrackerSamples = 16
	TrackerWindow  = 0.1 // seconds of history considered
	TrackerTau     = TrackerWindow / 2
)

type sample struct {
	t, x, y float64
}

// Tracker is a ring buffer of pointer samples.
type Tracker struct {
	buf   [TrackerSamples]sample
	head  int // index of oldest sample (when full)
	count int
	last  sample
	has   bool
}

// Push records a sample. t in seconds (any monotonic clock), x/y in px.
func (tr *Tracker) Push(t, x, y float64) {
	tr.last = sample{t, x, y}
	tr.has = true
	if tr.count < TrackerSamples {
		tr.buf[tr.count] = tr.last
		tr.count++
		return
	}
	tr.buf[tr.head] = tr.last
	tr.head = (tr.head + 1) % TrackerSamples
}

// Velocity returns (vx, vy) in px/s. Zero when fewer than 2 usable samples.
func (tr *Tracker) Velocity() (vx, vy float64) {
	if tr.count < 2 || !tr.has {
		return 0, 0
	}
	tEnd := tr.last.t
	// Weighted least squares of x(t), y(t) over samples inside the window:
	// slope = sum(w*(t-tbar)*(v-vbar)) / sum(w*(t-tbar)^2)
	var sw, st, sx, sy float64
	weights := [TrackerSamples]float64{}
	n := 0
	for i := 0; i < tr.count; i++ {
		s := tr.sampleAt(i)
		dt := tEnd - s.t
		if dt < 0 || dt > TrackerWindow {
			continue
		}
		w := math.Exp(-dt / TrackerTau)
		weights[i] = w
		sw += w
		st += w * s.t
		sx += w * s.x
		sy += w * s.y
		n++
	}
	if n < 2 || sw == 0 {
		return 0, 0
	}
	tbar, xbar, ybar := st/sw, sx/sw, sy/sw
	var numX, numY, den float64
	for i := 0; i < tr.count; i++ {
		w := weights[i]
		if w == 0 {
			continue
		}
		s := tr.sampleAt(i)
		dt := s.t - tbar
		numX += w * dt * (s.x - xbar)
		numY += w * dt * (s.y - ybar)
		den += w * dt * dt
	}
	if den == 0 {
		return 0, 0
	}
	return numX / den, numY / den
}

// Clear drops all samples (on pointer-down of a new gesture).
func (tr *Tracker) Clear() {
	tr.head, tr.count = 0, 0
	tr.has = false
}

// sampleAt returns the i-th sample chronologically (0 = oldest).
func (tr *Tracker) sampleAt(i int) sample {
	if tr.count < TrackerSamples {
		return tr.buf[i]
	}
	return tr.buf[(tr.head+i)%TrackerSamples]
}
