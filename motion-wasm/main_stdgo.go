//go:build !tinygo

// Standard-Go front-end for LOCAL verification only (Go >= 1.24):
// identical export names/signatures as the TinyGo artifact so the same
// Node ABI tests and browser smoke page run against both builds. This build
// is big (full Go runtime) and is never committed nor shipped — CI rebuilds
// the artifact with TinyGo.
package main

import "time"

//go:wasmexport engine_init
func engineInit(capacity int32) { abiEngineInit(capacity) }

//go:wasmexport engine_capacity
func engineCapacity() int32 { return abiEngineCapacity() }

//go:wasmexport engine_configure
func engineConfigure(id int32, response, damping float64) {
	abiEngineConfigure(id, response, damping)
}

//go:wasmexport engine_configure_standard
func engineConfigureStandard(id, standard int32) int32 {
	return abiEngineConfigureStandard(id, standard)
}

//go:wasmexport engine_set_epsilon
func engineSetEpsilon(posEps, velEps float64) { abiEngineSetEpsilon(posEps, velEps) }

//go:wasmexport engine_animate_to
func engineAnimateTo(id int32, target float64) { abiEngineAnimateTo(id, target) }

//go:wasmexport engine_animate_to_delayed
func engineAnimateToDelayed(id int32, target, delay float64) {
	abiEngineAnimateToDelayed(id, target, delay)
}

//go:wasmexport engine_flick_to
func engineFlickTo(id int32, target, velocity float64) { abiEngineFlickTo(id, target, velocity) }

//go:wasmexport engine_set_value
func engineSetValue(id int32, value float64) { abiEngineSetValue(id, value) }

//go:wasmexport engine_get_value
func engineGetValue(id int32) float64 { return abiEngineGetValue(id) }

//go:wasmexport engine_get_velocity
func engineGetVelocity(id int32) float64 { return abiEngineGetVelocity(id) }

//go:wasmexport engine_is_active
func engineIsActive(id int32) int32 { return abiEngineIsActive(id) }

//go:wasmexport engine_stop
func engineStop(id int32) { abiEngineStop(id) }

//go:wasmexport engine_tick
func engineTick(dt float64) int32 { return abiEngineTick(dt) }

//go:wasmexport engine_buffer_ptr
func engineBufferPtr() int32 { return abiEngineBufferPtr() }

//go:wasmexport engine_buffer_len
func engineBufferLen() int32 { return abiEngineBufferLen() }

//go:wasmexport tracker_push
func trackerPush(id int32, t, x, y float64) { abiTrackerPush(id, t, x, y) }

//go:wasmexport tracker_velocity_x
func trackerVelocityX(id int32) float64 { return abiTrackerVelocityX(id) }

//go:wasmexport tracker_velocity_y
func trackerVelocityY(id int32) float64 { return abiTrackerVelocityY(id) }

//go:wasmexport tracker_clear
func trackerClear(id int32) { abiTrackerClear(id) }

//go:wasmexport project
func project(velocity, decelRate float64) float64 { return abiProject(velocity, decelRate) }

//go:wasmexport rubberband
func rubberband(overshoot, dimension, constant float64) float64 {
	return abiRubberband(overshoot, dimension, constant)
}

//go:wasmexport rubberband_clamp
func rubberbandClamp(value, min, max, dimension, constant float64) float64 {
	return abiRubberbandClamp(value, min, max, dimension, constant)
}

//go:wasmexport cubic_bezier_sample
func cubicBezierSample(x1, y1, x2, y2, x float64) float64 {
	return abiCubicBezierSample(x1, y1, x2, y2, x)
}

func main() {
	// Keep the Go runtime alive so wasmexport functions stay callable.
	// A bare select{} trips the deadlock detector; a sleeping goroutine
	// keeps a pending timer and parks cleanly.
	for {
		time.Sleep(24 * time.Hour)
	}
}
