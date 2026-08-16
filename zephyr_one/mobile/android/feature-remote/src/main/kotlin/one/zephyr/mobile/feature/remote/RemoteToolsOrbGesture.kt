package one.zephyr.mobile.feature.remote

/** Gesture policy for the remote tools orb. */
object RemoteToolsOrbGesture {
    const val LONG_PRESS_MS = 500L
    const val TAP_SLOP_PX = 18f

    fun isTap(elapsedMs: Long, travelPx: Float): Boolean =
        elapsedMs < LONG_PRESS_MS && travelPx <= TAP_SLOP_PX
}
