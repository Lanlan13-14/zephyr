package one.zephyr.mobile.ui.glass

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class LiquidGlassTest {

    @Test
    fun shaderStringsContainRequiredSdfAndRefractionFunctions() {
        assertTrue(RoundedRectRefractionShaderString.contains("sdRoundedRect"))
        assertTrue(RoundedRectRefractionShaderString.contains("gradSdRoundedRect"))
        assertTrue(RoundedRectRefractionShaderString.contains("radiusAt"))
        assertTrue(RoundedRectRefractionShaderString.contains("refractionHeight"))
        assertTrue(RoundedRectRefractionShaderString.contains("refractionAmount"))

        assertTrue(RoundedRectRefractionWithDispersionShaderString.contains("chromaticAberration"))
        assertTrue(RoundedRectRefractionWithDispersionShaderString.contains("dispersionIntensity"))

        assertTrue(DefaultHighlightShaderString.contains("layout(color) uniform half4 color"))
        assertTrue(DefaultHighlightShaderString.contains("angle"))
        assertTrue(DefaultHighlightShaderString.contains("falloff"))

        assertTrue(AmbientHighlightShaderString.contains("main(float2 coord)"))
    }

    @Test
    fun emptyBackdropDoesNotRequireCoordinates() {
        val empty = emptyBackdrop()
        assertFalse(empty.isCoordinatesDependent)
    }

    @Test
    fun highlightDefaultsAreConsistent() {
        val default = Highlight.Default
        assertEquals(0.5f.dp, default.width)
        assertEquals(0.25f.dp, default.blurRadius)
        assertEquals(1f, default.alpha, 0.001f)
        assertTrue(default.style is HighlightStyle.Default)

        val ambient = Highlight.Ambient
        assertTrue(ambient.style is HighlightStyle.Ambient)

        val plain = Highlight.Plain
        assertTrue(plain.style is HighlightStyle.Plain)
    }

    @Test
    fun highlightStylesProvideAppropriateBlendModes() {
        val defaultStyle = HighlightStyle.Default(color = Color.White, angle = 45f)
        assertEquals(BlendMode.Plus, defaultStyle.blendMode)
        assertEquals(Color.White, defaultStyle.color)

        val plainStyle = HighlightStyle.Plain()
        assertEquals(BlendMode.Plus, plainStyle.blendMode)

        val ambientStyle = HighlightStyle.Ambient()
        assertEquals(BlendMode.SrcOver, ambientStyle.blendMode)
    }

    @Test
    fun shadowDefaultsHaveExpectedRadiusAndOffsets() {
        val shadow = Shadow.Default
        assertEquals(24f.dp, shadow.radius)
        assertEquals(DpOffset(0f.dp, 4f.dp), shadow.offset)
        assertEquals(1f, shadow.alpha, 0.001f)

        val innerShadow = InnerShadow.Default
        assertEquals(24f.dp, innerShadow.radius)
        assertEquals(DpOffset(0f.dp, 24f.dp), innerShadow.offset)
    }

    @Test
    fun capsuleShapeCreatesRoundedOutline() {
        val capsule = Capsule()
        val density = Density(density = 2f, fontScale = 1f)
        val size = Size(200f, 60f)
        val outline = capsule.createOutline(size, LayoutDirection.Ltr, density)

        assertTrue(outline is Outline.Rounded)
        val rounded = outline as Outline.Rounded
        assertEquals(30f, rounded.roundRect.topLeftCornerRadius.x, 0.001f)
        assertEquals(30f, rounded.roundRect.bottomRightCornerRadius.y, 0.001f)
    }

    @Test
    fun shapeProviderCachesOutlineForSameSize() {
        val capsule = Capsule()
        val provider = ShapeProvider { capsule }
        val density = Density(density = 2f, fontScale = 1f)
        val size = Size(160f, 50f)

        val outline1 = provider.shape.createOutline(size, LayoutDirection.Ltr, density)
        val outline2 = provider.shape.createOutline(size, LayoutDirection.Ltr, density)
        assertSame(outline1, outline2)
    }

    @Test
    fun runtimeShaderCacheObtainsSameShaderInstance() {
        val cache = RuntimeShaderCacheImpl()
        val s1 = cache.obtainRuntimeShader("testKey", RoundedRectRefractionShaderString)
        val s2 = cache.obtainRuntimeShader("testKey", RoundedRectRefractionShaderString)
        assertNotNull(s1)
        assertSame(s1, s2)

        cache.clear()
        val s3 = cache.obtainRuntimeShader("testKey", RoundedRectRefractionShaderString)
        assertNotNull(s3)
    }
}
