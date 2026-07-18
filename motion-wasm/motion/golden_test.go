package motion

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// Golden vectors cross-verify three implementations of the same math:
// this Go package, the wasm build (via Node ABI tests), and the JS fallback
// solver (public/vendor/zephyr-motion/spring.js). Regenerate with:
//
//	go test ./motion -run TestGoldenVectors -update
//
// Consumers must match every sample within 1e-9 (same closed form, same
// float64 math — anything looser hides a real divergence).
type goldenVector struct {
	Response float64   `json:"response"`
	Damping  float64   `json:"damping"`
	X0       float64   `json:"x0"`
	V0       float64   `json:"v0"`
	Target   float64   `json:"target"`
	Times    []float64 `json:"times"`
	Values   []float64 `json:"values"`
	Vels     []float64 `json:"velocities"`
}

var update = os.Getenv("UPDATE_GOLDEN") == "1"

func goldenCases() []goldenVector {
	cases := []struct{ response, damping, x0, v0, target float64 }{
		{0.4, 1.0, 0, 0, 100},      // critical, rest start
		{0.3, 0.8, 0, 0, 200},      // sheet preset, overshoot
		{0.22, 0.95, 1, 0, 1.26},   // dock magnify range
		{0.45, 0.92, 0, 800, 300},  // flick with velocity
		{0.28, 1.0, 0, -250, 50},   // reverse initial velocity
		{0.5, 1.6, 0, 0, 100},      // overdamped
		{0.35, 0.55, 10, 0, -40},   // strong underdamp, negative target
	}
	times := []float64{0.008, 0.016, 0.05, 0.1, 0.17, 0.25, 0.4, 0.6, 0.9, 1.4, 2.0}
	out := make([]goldenVector, len(cases))
	for i, c := range cases {
		s := NewSpring(c.response, c.damping)
		s.Set(c.x0)
		s.Flick(c.target, c.v0)
		vals := make([]float64, len(times))
		vels := make([]float64, len(times))
		for j, tm := range times {
			vals[j], vels[j] = s.eval(tm)
		}
		out[i] = goldenVector{c.response, c.damping, c.x0, c.v0, c.target, times, vals, vels}
	}
	return out
}

func TestGoldenVectors(t *testing.T) {
	path := filepath.Join("testdata", "motion-golden.json")
	cases := goldenCases()

	if update {
		data, err := json.MarshalIndent(cases, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %d vectors to %s", len(cases), path)
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden file (run with UPDATE_GOLDEN=1): %v", err)
	}
	var stored []goldenVector
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) != len(cases) {
		t.Fatalf("stored %d vectors, computed %d — stale golden file", len(stored), len(cases))
	}
	for i := range cases {
		for j := range cases[i].Times {
			if math.Abs(stored[i].Values[j]-cases[i].Values[j]) > 1e-9 ||
				math.Abs(stored[i].Vels[j]-cases[i].Vels[j]) > 1e-9 {
				t.Fatalf("vector %d time %v drifted: stored (%v,%v) computed (%v,%v)",
					i, cases[i].Times[j], stored[i].Values[j], stored[i].Vels[j],
					cases[i].Values[j], cases[i].Vels[j])
			}
		}
	}
}
