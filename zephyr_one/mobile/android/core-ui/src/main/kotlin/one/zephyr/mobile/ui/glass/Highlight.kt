package one.zephyr.mobile.ui.glass

import android.graphics.BlurMaskFilter
import androidx.annotation.FloatRange
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PaintingStyle
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.requireGraphicsContext
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.fastCoerceAtMost
import kotlin.math.PI
import kotlin.math.ceil

@Immutable
data class Highlight(
    val width: Dp = 0.5f.dp,
    val blurRadius: Dp = width / 2f,
    @param:FloatRange(from = 0.0, to = 1.0) val alpha: Float = 1f,
    val style: HighlightStyle = HighlightStyle.Default,
) {
    companion object {
        @Stable
        val Default: Highlight = Highlight()

        @Stable
        val Ambient: Highlight = Highlight(style = HighlightStyle.Ambient)

        @Stable
        val Plain: Highlight = Highlight(style = HighlightStyle.Plain)
    }
}

@Immutable
interface HighlightStyle {
    val color: Color
    val blendMode: BlendMode

    fun DrawScope.createShader(
        shape: Shape,
        runtimeShaderCache: RuntimeShaderCache,
    ): RuntimeShader?

    @Immutable
    data class Plain(
        override val color: Color = Color.White.copy(alpha = 0.38f),
        override val blendMode: BlendMode = BlendMode.Plus,
    ) : HighlightStyle {
        override fun DrawScope.createShader(
            shape: Shape,
            runtimeShaderCache: RuntimeShaderCache,
        ): RuntimeShader? = null
    }

    @Immutable
    data class Default(
        override val color: Color = Color.White.copy(alpha = 0.5f),
        override val blendMode: BlendMode = BlendMode.Plus,
        val angle: Float = 45f,
        @param:FloatRange(from = 0.0) val falloff: Float = 1f,
    ) : HighlightStyle {
        override fun DrawScope.createShader(
            shape: Shape,
            runtimeShaderCache: RuntimeShaderCache,
        ): RuntimeShader? {
            return if (isRuntimeShaderSupported()) {
                runtimeShaderCache.obtainRuntimeShader(
                    "Default",
                    DefaultHighlightShaderString,
                ).apply {
                    setFloatUniform("size", size.width, size.height)
                    setFloatUniform("cornerRadii", getCornerRadii(shape))
                    setColorUniform("color", color.copy(alpha = 1f))
                    setFloatUniform("angle", angle * (PI / 180f).toFloat())
                    setFloatUniform("falloff", falloff)
                }
            } else {
                null
            }
        }
    }

    @Immutable
    data class Ambient(
        @param:FloatRange(from = 0.0, to = 1.0) val intensity: Float = 0.38f,
    ) : HighlightStyle {
        override val color: Color = Color.White.copy(alpha = intensity)
        override val blendMode: BlendMode = BlendMode.SrcOver

        override fun DrawScope.createShader(
            shape: Shape,
            runtimeShaderCache: RuntimeShaderCache,
        ): RuntimeShader? {
            return if (isRuntimeShaderSupported()) {
                runtimeShaderCache.obtainRuntimeShader(
                    "Ambient",
                    AmbientHighlightShaderString,
                ).apply {
                    setFloatUniform("size", size.width, size.height)
                    setFloatUniform("cornerRadii", getCornerRadii(shape))
                    setFloatUniform("angle", 45f * (PI / 180f).toFloat())
                    setFloatUniform("falloff", 1f)
                }
            } else {
                null
            }
        }
    }

    companion object {
        @Stable
        val Default: Default = Default()

        @Stable
        val Ambient: Ambient = Ambient()

        @Stable
        val Plain: Plain = Plain()
    }
}

private fun DrawScope.getCornerRadii(shape: Shape): FloatArray {
    val sz = size
    val maxRadius = sz.minDimension / 2f
    val cornerShape = shape as? CornerBasedShape ?: return FloatArray(4) { maxRadius }
    val isLtr = layoutDirection == LayoutDirection.Ltr
    val tl = if (isLtr) cornerShape.topStart.toPx(sz, this) else cornerShape.topEnd.toPx(sz, this)
    val tr = if (isLtr) cornerShape.topEnd.toPx(sz, this) else cornerShape.topStart.toPx(sz, this)
    val br = if (isLtr) cornerShape.bottomEnd.toPx(sz, this) else cornerShape.bottomStart.toPx(sz, this)
    val bl = if (isLtr) cornerShape.bottomStart.toPx(sz, this) else cornerShape.bottomEnd.toPx(sz, this)
    return floatArrayOf(
        tl.fastCoerceAtMost(maxRadius),
        tr.fastCoerceAtMost(maxRadius),
        br.fastCoerceAtMost(maxRadius),
        bl.fastCoerceAtMost(maxRadius),
    )
}

internal class HighlightElement(
    val shapeProvider: ShapeProvider,
    val highlight: () -> Highlight?,
) : ModifierNodeElement<HighlightNode>() {

    override fun create(): HighlightNode = HighlightNode(shapeProvider, highlight)

    override fun update(node: HighlightNode) {
        node.shapeProvider = shapeProvider
        node.highlight = highlight
        node.invalidateDraw()
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "highlight"
        properties["shapeProvider"] = shapeProvider
        properties["highlight"] = highlight
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is HighlightElement) return false
        return shapeProvider == other.shapeProvider && highlight == other.highlight
    }

    override fun hashCode(): Int = 31 * shapeProvider.hashCode() + highlight.hashCode()
}

internal class HighlightNode(
    var shapeProvider: ShapeProvider,
    var highlight: () -> Highlight?,
) : DrawModifierNode, Modifier.Node() {

    override val shouldAutoInvalidate: Boolean = false

    private var highlightLayer: GraphicsLayer? = null
    private val paint = Paint().apply { style = PaintingStyle.Stroke }
    private var clipPath: Path? = null
    private val runtimeShaderCache = RuntimeShaderCacheImpl()

    override fun ContentDrawScope.draw() {
        val hl = highlight()
        if (hl == null || hl.width.value <= 0f) {
            drawContent()
            return
        }

        drawContent()

        val layer = highlightLayer ?: return
        val sz = size
        val density: Density = this
        val safeSize = IntSize(
            ceil(sz.width).toInt() + 2,
            ceil(sz.height).toInt() + 2,
        )

        val outline = shapeProvider.shape.createOutline(sz, layoutDirection, density)
        val cp = if (outline is Outline.Rounded) {
            clipPath ?: Path().also { clipPath = it }
        } else {
            null
        }

        configurePaint(hl)

        layer.alpha = hl.alpha
        layer.blendMode = hl.style.blendMode
        layer.record(safeSize) {
            translate(1f, 1f) {
                val canvas = drawContext.canvas
                canvas.save()
                canvas.clipOutline(outline, cp)
                canvas.drawOutline(outline, paint)
                canvas.restore()
            }
        }

        translate(-1f, -1f) {
            drawLayer(layer)
        }
    }

    override fun onAttach() {
        val graphicsContext = requireGraphicsContext()
        highlightLayer = graphicsContext.createGraphicsLayer()
    }

    override fun onDetach() {
        val graphicsContext = requireGraphicsContext()
        highlightLayer?.let { layer ->
            graphicsContext.releaseGraphicsLayer(layer)
            highlightLayer = null
        }
        clipPath = null
        runtimeShaderCache.clear()
    }

    private fun DrawScope.configurePaint(hl: Highlight) {
        paint.color = hl.style.color
        paint.strokeWidth = ceil(hl.width.toPx().fastCoerceAtMost(size.minDimension / 2f)) * 2f
        val radius = hl.blurRadius.toPx()
        paint.asFrameworkPaint().maskFilter = if (radius > 0f) BlurMaskFilter(radius, BlurMaskFilter.Blur.NORMAL) else null

        if (isRuntimeShaderSupported()) {
            val shader = with(hl.style) {
                createShader(
                    shape = shapeProvider.shape,
                    runtimeShaderCache = runtimeShaderCache,
                )
            }
            paint.asFrameworkPaint().shader = shader?.asAndroidRuntimeShader()
        }
    }
}
