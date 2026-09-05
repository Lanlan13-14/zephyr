package one.zephyr.mobile.ui.glass

import android.graphics.BlurMaskFilter
import androidx.annotation.FloatRange
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.CompositingStrategy
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.requireGraphicsContext
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.math.ceil

@Immutable
data class Shadow(
    val radius: Dp = 24f.dp,
    val offset: DpOffset = DpOffset(0f.dp, radius / 6f),
    val color: Color = Color.Black.copy(alpha = 0.1f),
    @param:FloatRange(from = 0.0, to = 1.0) val alpha: Float = 1f,
    val blendMode: BlendMode = BlendMode.SrcOver,
) {
    companion object {
        @Stable
        val Default: Shadow = Shadow()
    }
}

@Immutable
data class InnerShadow(
    val radius: Dp = 24f.dp,
    val offset: DpOffset = DpOffset(0f.dp, radius),
    val color: Color = Color.Black.copy(alpha = 0.15f),
    @param:FloatRange(from = 0.0, to = 1.0) val alpha: Float = 1f,
    val blendMode: BlendMode = BlendMode.SrcOver,
) {
    companion object {
        @Stable
        val Default: InnerShadow = InnerShadow()
    }
}

private val ShadowMaskPaint = Paint().apply {
    blendMode = BlendMode.Clear
}

internal class ShadowElement(
    val shapeProvider: ShapeProvider,
    val shadow: () -> Shadow?,
) : ModifierNodeElement<ShadowNode>() {

    override fun create(): ShadowNode = ShadowNode(shapeProvider, shadow)

    override fun update(node: ShadowNode) {
        node.shapeProvider = shapeProvider
        node.shadow = shadow
        node.invalidateDraw()
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "shadow"
        properties["shapeProvider"] = shapeProvider
        properties["shadow"] = shadow
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ShadowElement) return false
        return shapeProvider == other.shapeProvider && shadow == other.shadow
    }

    override fun hashCode(): Int = 31 * shapeProvider.hashCode() + shadow.hashCode()
}

internal class ShadowNode(
    var shapeProvider: ShapeProvider,
    var shadow: () -> Shadow?,
) : DrawModifierNode, Modifier.Node() {

    override val shouldAutoInvalidate: Boolean = false

    private var shadowLayer: GraphicsLayer? = null
    private val paint = Paint()

    override fun ContentDrawScope.draw() {
        val sh = shadow() ?: run {
            drawContent()
            return
        }
        if (size.minDimension < 1f) {
            drawContent()
            return
        }

        val layer = shadowLayer
        if (layer != null) {
            val sz = size
            val density: Density = this
            val radius = sh.radius.toPx()
            val offsetX = sh.offset.x.toPx()
            val offsetY = sh.offset.y.toPx()
            val shadowSize = IntSize(
                ceil(sz.width + radius * 4f + offsetX).toInt(),
                ceil(sz.height + radius * 4f + offsetY).toInt(),
            )
            val outline = shapeProvider.shape.createOutline(sz, layoutDirection, density)

            paint.color = sh.color
            val blurRad = sh.radius.toPx()
            paint.asFrameworkPaint().maskFilter = if (blurRad > 0f) BlurMaskFilter(blurRad, BlurMaskFilter.Blur.NORMAL) else null

            layer.alpha = sh.alpha
            layer.blendMode = sh.blendMode
            val recorded = recordLayer(layer, shadowSize) {
                translate(radius * 2f + offsetX, radius * 2f + offsetY) {
                    val canvas = drawContext.canvas
                    canvas.drawOutline(outline, paint)
                    canvas.translate(-offsetX, -offsetY)
                    canvas.drawOutline(outline, ShadowMaskPaint)
                    canvas.translate(offsetX, offsetY)
                }
            }
            if (recorded) {
                translate(-radius * 2f, -radius * 2f) {
                    drawLayer(layer)
                }
            }
        }

        drawContent()
    }

    override fun onAttach() {
        val graphicsContext = requireGraphicsContext()
        shadowLayer = graphicsContext.createGraphicsLayer().apply {
            compositingStrategy = CompositingStrategy.Offscreen
        }
    }

    override fun onDetach() {
        val graphicsContext = requireGraphicsContext()
        shadowLayer?.let { layer ->
            graphicsContext.releaseGraphicsLayer(layer)
            shadowLayer = null
        }
    }
}

internal class InnerShadowElement(
    val shapeProvider: ShapeProvider,
    val shadow: () -> InnerShadow?,
) : ModifierNodeElement<InnerShadowNode>() {

    override fun create(): InnerShadowNode = InnerShadowNode(shapeProvider, shadow)

    override fun update(node: InnerShadowNode) {
        node.shapeProvider = shapeProvider
        node.shadow = shadow
        node.invalidateDraw()
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "innerShadow"
        properties["shapeProvider"] = shapeProvider
        properties["shadow"] = shadow
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is InnerShadowElement) return false
        return shapeProvider == other.shapeProvider && shadow == other.shadow
    }

    override fun hashCode(): Int = 31 * shapeProvider.hashCode() + shadow.hashCode()
}

internal class InnerShadowNode(
    var shapeProvider: ShapeProvider,
    var shadow: () -> InnerShadow?,
) : DrawModifierNode, Modifier.Node() {

    override val shouldAutoInvalidate: Boolean = false

    private var shadowLayer: GraphicsLayer? = null
    private val paint = Paint()
    private var clipPath: Path? = null
    private var prevRadius = Float.NaN

    override fun ContentDrawScope.draw() {
        drawContent()

        if (!isRenderEffectSupported()) return
        if (size.minDimension < 1f) return

        val sh = shadow() ?: return
        val layer = shadowLayer ?: return

        val sz = size
        val density: Density = this
        val radius = sh.radius.toPx()
        val offsetX = sh.offset.x.toPx()
        val offsetY = sh.offset.y.toPx()

        val outline = shapeProvider.shape.createOutline(sz, layoutDirection, density)
        val cp = if (outline is Outline.Rounded) {
            clipPath ?: Path().also { clipPath = it }
        } else {
            null
        }

        paint.color = sh.color

        layer.alpha = sh.alpha
        layer.blendMode = sh.blendMode
        if (prevRadius != radius) {
            layer.renderEffect = if (radius > 0f) BlurEffect(radius, radius, TileMode.Decal) else null
            prevRadius = radius
        }
        val recorded = recordLayer(layer) {
            val canvas = drawContext.canvas
            canvas.save()
            canvas.clipOutline(outline, cp)
            canvas.drawOutline(outline, paint)
            canvas.translate(offsetX, offsetY)
            canvas.drawOutline(outline, ShadowMaskPaint)
            canvas.translate(-offsetX, -offsetY)
            canvas.restore()
        }
        if (!recorded) return

        val canvas = drawContext.canvas
        canvas.save()
        canvas.clipOutline(outline, cp)
        drawLayer(layer)
        canvas.restore()
    }

    override fun onAttach() {
        val graphicsContext = requireGraphicsContext()
        shadowLayer = graphicsContext.createGraphicsLayer().apply {
            compositingStrategy = CompositingStrategy.Offscreen
        }
    }

    override fun onDetach() {
        val graphicsContext = requireGraphicsContext()
        shadowLayer?.let { layer ->
            graphicsContext.releaseGraphicsLayer(layer)
            shadowLayer = null
        }
    }
}
