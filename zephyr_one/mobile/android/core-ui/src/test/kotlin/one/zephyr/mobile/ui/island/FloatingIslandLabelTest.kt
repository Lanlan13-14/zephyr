package one.zephyr.mobile.ui.island

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FloatingIslandLabelTest {

    private val androidRoot = File(".").canonicalFile.let { current ->
        generateSequence(current) { it.parentFile }.first {
            File(it, "core-ui/src/main/kotlin/one/zephyr/mobile/ui/island/FloatingIsland.kt").exists()
        }
    }

    @Test
    fun `selected label is not clipped to a fixed height`() {
        val source = File(
            androidRoot,
            "core-ui/src/main/kotlin/one/zephyr/mobile/ui/island/FloatingIsland.kt",
        ).readText()
        assertFalse(source.contains("labelHeight"))
        assertFalse(source.contains("11.dp"))
        assertTrue(source.contains("if (isSelected)"))
        assertTrue(source.contains("overflow = TextOverflow.Visible"))
        assertFalse(source.contains("softWrap"))
    }

    @Test
    fun `island label style keeps full glyphs`() {
        val source = File(
            androidRoot,
            "core-ui/src/main/kotlin/one/zephyr/mobile/ui/theme/Typography.kt",
        ).readText()
        val island = source.substringAfter("val islandLabel").substringBefore("val stat")
        assertTrue(island.contains("lineHeight = 13.sp"))
        assertTrue(island.contains("LineHeightStyle.Trim.Both"))
        assertFalse(island.contains("Trim.None"))
    }
}
