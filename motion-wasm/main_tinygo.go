//go:build tinygo

// TinyGo front-end: plain C-ABI exports, freestanding module — the JS host
// instantiates with empty imports, calls engine_init, and ticks. Built in CI
// via scripts/build-motion-wasm.sh (small artifact, committed to
// public/vendor/zephyr-motion/zephyr_motion.wasm).
package main

//export engine_init
func engineInit(capacity int32) { abiEngineInit(capacity) }

//export engine_capacity
func engineCapacity() int32 { return abiEngineCapacity() }

//export engine_configure
func engineConfigure(id int32, response, damping float64) {
	abiEngineConfigure(id, response, damping)
}

//export engine_set_epsilon
func engineSetEpsilon(posEps, velEps float64) { abiEngineSetEpsilon(posEps, velEps) }

//export engine_animate_to
func engineAnimateTo(id int32, target float64) { abiEngineAnimateTo(id, target) }

//export engine_animate_to_delayed
func engineAnimateToDelayed(id int32, target, delay float64) {
	abiEngineAnimateToDelayed(id, target, delay)
}

//export engine_flick_to
func engineFlickTo(id int32, target, velocity float64) { abiEngineFlickTo(id, target, velocity) }

//export engine_set_value
func engineSetValue(id int32, value float64) { abiEngineSetValue(id, value) }

//export engine_get_value
func engineGetValue(id int32) float64 { return abiEngineGetValue(id) }

//export engine_get_velocity
func engineGetVelocity(id int32) float64 { return abiEngineGetVelocity(id) }

//export engine_is_active
func engineIsActive(id int32) int32 { return abiEngineIsActive(id) }

//export engine_stop
func engineStop(id int32) { abiEngineStop(id) }

//export engine_tick
func engineTick(dt float64) int32 { return abiEngineTick(dt) }

//export engine_buffer_ptr
func engineBufferPtr() int32 { return abiEngineBufferPtr() }

//export engine_buffer_len
func engineBufferLen() int32 { return abiEngineBufferLen() }

//export tracker_push
func trackerPush(id int32, t, x, y float64) { abiTrackerPush(id, t, x, y) }

//export tracker_velocity_x
func trackerVelocityX(id int32) float64 { return abiTrackerVelocityX(id) }

//export tracker_velocity_y
func trackerVelocityY(id int32) float64 { return abiTrackerVelocityY(id) }

//export tracker_clear
func trackerClear(id int32) { abiTrackerClear(id) }

//export project
func project(velocity, decelRate float64) float64 { return abiProject(velocity, decelRate) }

//export rubberband
func rubberband(overshoot, dimension, constant float64) float64 {
	return abiRubberband(overshoot, dimension, constant)
}

//export rubberband_clamp
func rubberbandClamp(value, min, max, dimension, constant float64) float64 {
	return abiRubberbandClamp(value, min, max, dimension, constant)
}

//export cubic_bezier_sample
func cubicBezierSample(x1, y1, x2, y2, x float64) float64 {
	return abiCubicBezierSample(x1, y1, x2, y2, x)
}

func main() {}
