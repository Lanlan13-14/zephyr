package main

// Shared ABI implementation behind the two export front-ends:
// main_tinygo.go (//export, CI size-optimised artifact) and
// main_stdgo.go (//go:wasmexport, local verification build).
//
// ABI rules (mirrored by public/vendor/zephyr-motion/runtime.js):
//   - ids, counts, flags are int32; values are float64.
//   - engine_buffer_* exposes the frame buffer (stride 3: value, velocity,
//     active) mapped JS-side as a Float64Array — zero copies per frame.
//   - trackers 0..trackerCount-1 are a fixed pool for gesture velocity.

import (
	"unsafe"

	"github.com/Lanlan13-14/zephyr-ssh/motion-wasm/motion"
)

const trackerCount = 8

var (
	engine   motion.Engine
	trackers [trackerCount]motion.Tracker
)

func abiEngineInit(capacity int32) {
	if capacity < 1 {
		capacity = 1
	}
	engine.Init(int(capacity))
	for i := range trackers {
		trackers[i].Clear()
	}
}

func abiEngineCapacity() int32 { return int32(engine.Capacity()) }

func abiEngineConfigure(id int32, response, damping float64) {
	engine.Configure(int(id), response, damping)
}

func abiEngineSetEpsilon(posEps, velEps float64) {
	if posEps > 0 {
		engine.PosEps = posEps
	}
	if velEps > 0 {
		engine.VelEps = velEps
	}
}

func abiEngineAnimateTo(id int32, target float64) { engine.AnimateTo(int(id), target) }

func abiEngineAnimateToDelayed(id int32, target, delay float64) {
	engine.AnimateToDelayed(int(id), target, delay)
}

func abiEngineFlickTo(id int32, target, velocity float64) {
	engine.Flick(int(id), target, velocity)
}

func abiEngineSetValue(id int32, value float64) { engine.SetValue(int(id), value) }

func abiEngineGetValue(id int32) float64 { return engine.Value(int(id)) }

func abiEngineGetVelocity(id int32) float64 { return engine.Velocity(int(id)) }

func abiEngineIsActive(id int32) int32 {
	if engine.IsActive(int(id)) {
		return 1
	}
	return 0
}

func abiEngineStop(id int32) { engine.Stop(int(id)) }

func abiEngineTick(dt float64) int32 { return int32(engine.Tick(dt)) }

func abiEngineBufferPtr() int32 {
	b := engine.Buffer()
	if len(b) == 0 {
		return 0
	}
	// wasm linear memory is < 4 GiB on both toolchains, so the pointer
	// fits in an (u)int32; JS re-reads ptr/len whenever memory grows.
	return int32(uint32(uintptr(unsafe.Pointer(&b[0]))))
}

func abiEngineBufferLen() int32 { return int32(len(engine.Buffer())) }

func trackerOK(id int32) bool { return id >= 0 && id < trackerCount }

func abiTrackerPush(id int32, t, x, y float64) {
	if trackerOK(id) {
		trackers[id].Push(t, x, y)
	}
}

func abiTrackerVelocityX(id int32) float64 {
	if !trackerOK(id) {
		return 0
	}
	vx, _ := trackers[id].Velocity()
	return vx
}

func abiTrackerVelocityY(id int32) float64 {
	if !trackerOK(id) {
		return 0
	}
	_, vy := trackers[id].Velocity()
	return vy
}

func abiTrackerClear(id int32) {
	if trackerOK(id) {
		trackers[id].Clear()
	}
}

func abiProject(velocity, decelRate float64) float64 {
	return motion.Project(velocity, decelRate)
}

func abiRubberband(overshoot, dimension, constant float64) float64 {
	return motion.Rubberband(overshoot, dimension, constant)
}

func abiRubberbandClamp(value, min, max, dimension, constant float64) float64 {
	return motion.RubberbandClamp(value, min, max, dimension, constant)
}

func abiCubicBezierSample(x1, y1, x2, y2, x float64) float64 {
	return motion.CubicBezierSample(x1, y1, x2, y2, x)
}
