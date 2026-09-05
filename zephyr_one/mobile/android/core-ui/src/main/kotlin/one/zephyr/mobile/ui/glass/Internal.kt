package one.zephyr.mobile.ui.glass

import androidx.compose.runtime.Immutable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.DefaultCameraDistance
import androidx.compose.ui.graphics.DefaultShadowColor
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.RenderEffect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.DrawTransform
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.toIntSize
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

internal fun DrawScope.recordLayer(
    layer: GraphicsLayer,
    size: IntSize = this.size.toIntSize(),
    density: Density? = null,
    block: DrawScope.() -> Unit,
) {
    val d = density ?: this
    layer.record(size) {
        val prevDensity = drawContext.density
        drawContext.density = d
        try {
            this.block()
        } finally {
            drawContext.density = prevDensity
        }
    }
}

internal fun Canvas.clipOutline(outline: Outline, path: Path?) {
    when (outline) {
        is Outline.Rectangle -> clipRect(outline.rect)
        is Outline.Rounded -> {
            path?.let {
                it.rewind()
                it.addRoundRect(outline.roundRect)
                clipPath(it)
            }
        }
        is Outline.Generic -> clipPath(outline.path)
    }
}

@Immutable
internal class ShapeProvider(val shapeBlock: () -> Shape) {
    private var cachedShape: Shape? = null
    private var cachedOutline: Outline? = null
    private var cachedSize: Size = Size.Unspecified
    private var cachedLayoutDirection: LayoutDirection? = null
    private var cachedDensity: Float? = null

    val innerShape: Shape
        get() = shapeBlock()

    val shape = object : Shape {
        override fun createOutline(
            size: Size,
            layoutDirection: LayoutDirection,
            density: Density,
        ): Outline {
            val s = shapeBlock()
            if (cachedShape != s) {
                cachedShape = s
                cachedOutline = null
            }
            if (cachedOutline == null || cachedSize != size || cachedLayoutDirection != layoutDirection || cachedDensity != density.density) {
                cachedSize = size
                cachedLayoutDirection = layoutDirection
                cachedDensity = density.density
                cachedOutline = s.createOutline(size, layoutDirection, density)
            }
            return cachedOutline!!
        }
    }
}

internal class InverseLayerScope : GraphicsLayerScope {
    override var size: Size = Size.Unspecified
    override var density: Float = 1f
    override var fontScale: Float = 1f
    override var scaleX: Float = 1f
    override var scaleY: Float = 1f
    override var alpha: Float = 0f
    override var translationX: Float = 0f
    override var translationY: Float = 0f
    override var shadowElevation: Float = 0f
    override var ambientShadowColor: Color = DefaultShadowColor
    override var spotShadowColor: Color = DefaultShadowColor
    override var rotationX: Float = 0f
    override var rotationY: Float = 0f
    override var rotationZ: Float = 0f
    override var cameraDistance: Float = DefaultCameraDistance
    override var transformOrigin: TransformOrigin = TransformOrigin.Center
    override var shape: Shape = RectangleShape
    override var clip: Boolean = false
    override var renderEffect: RenderEffect? = null
    override var blendMode: BlendMode = BlendMode.SrcOver
    override var colorFilter: ColorFilter? = null
    override var compositingStrategy: CompositingStrategy = CompositingStrategy.Auto

    private var matrix: Matrix? = null

    fun DrawTransform.inverseTransform(
        density: Density,
        layerBlock: GraphicsLayerScope.() -> Unit,
    ) {
        this@InverseLayerScope.size = size
        this@InverseLayerScope.density = density.density
        fontScale = density.fontScale

        layerBlock()

        inverseTransformAtTopLeft(
            rotationZ = rotationZ,
            scaleX = scaleX,
            scaleY = scaleY,
        )
    }

    fun reset() {
        size = Size.Unspecified
        density = 1f
        fontScale = 1f
        scaleX = 1f
        scaleY = 1f
        alpha = 1f
        translationX = 0f
        translationY = 0f
        shadowElevation = 0f
        ambientShadowColor = DefaultShadowColor
        spotShadowColor = DefaultShadowColor
        rotationX = 0f
        rotationY = 0f
        rotationZ = 0f
        cameraDistance = DefaultCameraDistance
        transformOrigin = TransformOrigin.Center
        shape = RectangleShape
        clip = false
        renderEffect = null
        blendMode = BlendMode.SrcOver
        colorFilter = null
        compositingStrategy = CompositingStrategy.Auto
        matrix = null
    }

    private fun DrawTransform.inverseTransformAtTopLeft(
        rotationZ: Float = 0f,
        scaleX: Float = 1f,
        scaleY: Float = 1f,
    ) {
        if (rotationZ == 0f) {
            if (scaleX != 0f && scaleY != 0f) {
                scale(1f / scaleX, 1f / scaleY, Offset.Zero)
            }
            return
        }

        val m = matrix ?: Matrix().also { matrix = it }
        if (m.values.size < 16) return

        val rz = rotationZ * (PI / 180.0)
        val rsz = sin(rz).toFloat()
        val rcz = cos(rz).toFloat()

        val a00 = rcz * scaleX
        val a01 = rsz * scaleY
        val a10 = -rsz * scaleX
        val a11 = rcz * scaleY

        val det = a00 * a11 - a01 * a10
        if (det == 0f) return
        val invDet = 1f / det
        m[0, 0] = a11 * invDet
        m[0, 1] = -a01 * invDet
        m[1, 0] = -a10 * invDet
        m[1, 1] = a00 * invDet

        transform(m)
    }
}
