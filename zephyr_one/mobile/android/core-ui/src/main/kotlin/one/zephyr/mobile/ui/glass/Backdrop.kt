package one.zephyr.mobile.ui.glass

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.GlobalPositionAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.unit.Density

interface Backdrop {
    val isCoordinatesDependent: Boolean

    fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)? = null,
    )
}

val LocalBackdrop = staticCompositionLocalOf<Backdrop> { emptyBackdrop() }

@Stable
fun emptyBackdrop(): Backdrop = EmptyBackdrop

@Immutable
private object EmptyBackdrop : Backdrop {
    override val isCoordinatesDependent: Boolean = false

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
    }
}

private val DefaultOnDraw: ContentDrawScope.() -> Unit = { drawContent() }

@Composable
fun rememberLayerBackdrop(
    graphicsLayer: GraphicsLayer = rememberGraphicsLayer(),
    onDraw: ContentDrawScope.() -> Unit = DefaultOnDraw,
): LayerBackdrop {
    return remember(graphicsLayer, onDraw) {
        LayerBackdrop(graphicsLayer, onDraw)
    }
}

@Stable
class LayerBackdrop internal constructor(
    val graphicsLayer: GraphicsLayer,
    internal val onDraw: ContentDrawScope.() -> Unit,
) : Backdrop {

    override val isCoordinatesDependent: Boolean = true

    internal var layerCoordinates: LayoutCoordinates? by mutableStateOf(null)

    /**
     * Bumped after every successful off-screen record. Glass consumers read this
     * during draw so they invalidate when the source layer's pixels change;
     * otherwise the island keeps sampling the first (often empty) frame.
     */
    internal var recordGeneration: Int by mutableIntStateOf(0)
        private set

    internal fun notifyRecorded() {
        recordGeneration += 1
    }

    private var inverseLayerScope: InverseLayerScope? = null

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
        recordGeneration
        val coords = coordinates ?: return
        val layerCoords = layerCoordinates ?: return
        withTransform({
            if (layerBlock != null) {
                with(obtainInverseLayerScope()) { inverseTransform(density, layerBlock) }
            }
            val offset = try {
                layerCoords.localPositionOf(coords)
            } catch (_: Exception) {
                coords.positionInWindow() - layerCoords.positionInWindow()
            }
            translate(-offset.x, -offset.y)
        }) {
            drawLayer(graphicsLayer)
        }
    }

    private fun obtainInverseLayerScope(): InverseLayerScope {
        return inverseLayerScope?.apply { reset() }
            ?: InverseLayerScope().also { inverseLayerScope = it }
    }
}

fun Modifier.layerBackdrop(backdrop: LayerBackdrop): Modifier =
    this.then(LayerBackdropElement(backdrop))

private class LayerBackdropElement(
    val backdrop: LayerBackdrop,
) : ModifierNodeElement<LayerBackdropNode>() {

    override fun create(): LayerBackdropNode {
        return LayerBackdropNode(backdrop)
    }

    override fun update(node: LayerBackdropNode) {
        if (node.backdrop != backdrop) {
            node.backdrop.layerCoordinates = null
            node.backdrop = backdrop
        }
        node.invalidateDraw()
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "layerBackdrop"
        properties["backdrop"] = backdrop
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is LayerBackdropElement) return false
        return backdrop == other.backdrop
    }

    override fun hashCode(): Int = backdrop.hashCode()
}

private class LayerBackdropNode(
    var backdrop: LayerBackdrop,
) : DrawModifierNode, GlobalPositionAwareModifierNode, Modifier.Node() {

    override fun ContentDrawScope.draw() {
        drawContent()
        if (size.width < 1f || size.height < 1f) return
        if (recordLayer(backdrop.graphicsLayer) { backdrop.onDraw(this@draw) }) {
            backdrop.notifyRecorded()
        }
    }

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        if (coordinates.isAttached) {
            backdrop.layerCoordinates = coordinates
        }
    }

    override fun onDetach() {
        backdrop.layerCoordinates = null
    }
}

@Composable
fun rememberCombinedBackdrop(
    backdrop1: Backdrop,
    backdrop2: Backdrop,
): Backdrop {
    return remember(backdrop1, backdrop2) {
        Combined2Backdrops(backdrop1, backdrop2)
    }
}

@Immutable
private class Combined2Backdrops(
    val backdrop1: Backdrop,
    val backdrop2: Backdrop,
) : Backdrop {

    override val isCoordinatesDependent: Boolean =
        backdrop1.isCoordinatesDependent || backdrop2.isCoordinatesDependent

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
        with(backdrop1) { drawBackdrop(density, coordinates, layerBlock) }
        with(backdrop2) { drawBackdrop(density, coordinates, layerBlock) }
    }
}

@Composable
fun rememberBackdrop(
    backdrop: Backdrop,
    onDraw: DrawScope.(drawBackdrop: DrawScope.() -> Unit) -> Unit,
): Backdrop {
    return remember(backdrop, onDraw) {
        DelegatingBackdrop(backdrop, onDraw)
    }
}

@Immutable
private class DelegatingBackdrop(
    val backdrop: Backdrop,
    val onDraw: DrawScope.(drawBackdrop: DrawScope.() -> Unit) -> Unit,
) : Backdrop {

    override val isCoordinatesDependent: Boolean = backdrop.isCoordinatesDependent

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
        onDraw { with(backdrop) { drawBackdrop(density, coordinates, layerBlock) } }
    }
}

@Composable
fun rememberCanvasBackdrop(
    onDraw: DrawScope.() -> Unit,
): Backdrop {
    return remember(onDraw) {
        CanvasBackdrop(onDraw)
    }
}

@Immutable
private class CanvasBackdrop(
    val onDraw: DrawScope.() -> Unit,
) : Backdrop {

    override val isCoordinatesDependent: Boolean = false

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
        onDraw()
    }
}

@Composable
fun rememberCombinedBackdrop(
    backdrop1: Backdrop,
    backdrop2: Backdrop,
    backdrop3: Backdrop,
): Backdrop {
    return remember(backdrop1, backdrop2, backdrop3) {
        Combined3Backdrops(backdrop1, backdrop2, backdrop3)
    }
}

@Immutable
private class Combined3Backdrops(
    val backdrop1: Backdrop,
    val backdrop2: Backdrop,
    val backdrop3: Backdrop,
) : Backdrop {

    override val isCoordinatesDependent: Boolean =
        backdrop1.isCoordinatesDependent ||
            backdrop2.isCoordinatesDependent ||
            backdrop3.isCoordinatesDependent

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
        with(backdrop1) { drawBackdrop(density, coordinates, layerBlock) }
        with(backdrop2) { drawBackdrop(density, coordinates, layerBlock) }
        with(backdrop3) { drawBackdrop(density, coordinates, layerBlock) }
    }
}

@Composable
fun rememberCombinedBackdrop(vararg backdrops: Backdrop): Backdrop {
    return remember(*backdrops) {
        CombinedBackdrops(*backdrops)
    }
}

@Immutable
private class CombinedBackdrops(
    vararg val backdrops: Backdrop,
) : Backdrop {

    override val isCoordinatesDependent: Boolean =
        backdrops.any { it.isCoordinatesDependent }

    override fun DrawScope.drawBackdrop(
        density: Density,
        coordinates: LayoutCoordinates?,
        layerBlock: (GraphicsLayerScope.() -> Unit)?,
    ) {
        backdrops.forEach { backdrop ->
            with(backdrop) { drawBackdrop(density, coordinates, layerBlock) }
        }
    }
}
