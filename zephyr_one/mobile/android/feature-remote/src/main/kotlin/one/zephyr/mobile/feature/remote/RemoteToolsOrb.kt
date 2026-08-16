package one.zephyr.mobile.feature.remote

/** Pixel bounds for the movable remote-tools orb inside the current safe drawing area. */
data class RemoteToolsOrbBounds(
    val minX: Float,
    val maxX: Float,
    val minY: Float,
    val maxY: Float,
)

data class RemoteToolsOrbPosition(val x: Float, val y: Float)

/** Pure geometry so rotation, insets, and edge clamping are testable without Compose. */
object RemoteToolsOrbGeometry {

    fun bounds(
        viewportWidthPx: Int,
        viewportHeightPx: Int,
        orbSizePx: Float,
        marginPx: Float,
        insetLeftPx: Int,
        insetTopPx: Int,
        insetRightPx: Int,
        insetBottomPx: Int,
    ): RemoteToolsOrbBounds {
        val minX = insetLeftPx + marginPx
        val minY = insetTopPx + marginPx
        return RemoteToolsOrbBounds(
            minX = minX,
            maxX = maxOf(minX, viewportWidthPx - insetRightPx - marginPx - orbSizePx),
            minY = minY,
            maxY = maxOf(minY, viewportHeightPx - insetBottomPx - marginPx - orbSizePx),
        )
    }

    fun initial(bounds: RemoteToolsOrbBounds): RemoteToolsOrbPosition = RemoteToolsOrbPosition(
        x = bounds.maxX,
        y = (bounds.minY + bounds.maxY) / 2f,
    )

    fun clamp(
        position: RemoteToolsOrbPosition,
        bounds: RemoteToolsOrbBounds,
    ): RemoteToolsOrbPosition = RemoteToolsOrbPosition(
        x = position.x.coerceIn(bounds.minX, bounds.maxX),
        y = position.y.coerceIn(bounds.minY, bounds.maxY),
    )

    fun move(
        position: RemoteToolsOrbPosition,
        dxPx: Float,
        dyPx: Float,
        bounds: RemoteToolsOrbBounds,
    ): RemoteToolsOrbPosition = clamp(
        RemoteToolsOrbPosition(position.x + dxPx, position.y + dyPx),
        bounds,
    )
}
