package one.zephyr.mobile.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class StartupThemeTest {

    private fun codeOnly(source: String): String =
        source
            .replace(Regex("/\\*[\\s\\S]*?\\*/"), " ")
            .replace(Regex("//[^\\n]*"), " ")
            .replace(Regex("\"\"\"[\\s\\S]*?\"\"\""), "\"\"")
            .replace(Regex("\"(?:\\\\.|[^\"\\\\\\n])*\""), "\"\"")


    private val androidRoot = File(".").canonicalFile.let { current ->
        generateSequence(current) { it.parentFile }.first { File(it, "app/src/main/res/values/themes.xml").exists() }
    }

    @Test
    fun `launch theme is frost light not black`() {
        val theme = File(androidRoot, "app/src/main/res/values/themes.xml").readText()
        val colors = File(androidRoot, "app/src/main/res/values/colors.xml").readText()
        assertFalse(theme.contains("@android:color/black"))
        assert(theme.contains("@color/zephyr_splash"))
        assert(colors.contains("#FFF2F4F7"))
    }

    @Test
    fun `application no longer blocks the main thread on recovery`() {
        val source = codeOnly(
            File(androidRoot, "app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneApplication.kt").readText(),
        )
        assertFalse(source.contains("runBlocking"))
        assertTrue(source.contains("readyState"))
        assertTrue(source.contains("applicationScope.launch"))
        assertTrue(source.contains("RdpAndroidRuntime.installHome"))
        assertTrue(source.contains("finally"))
        assertTrue(source.contains("readyState.value = true"))
        assertTrue(source.contains("TimeoutCancellationException"))
    }

    @Test
    fun `activity waits for recovery before drawing the tree`() {
        val source = codeOnly(
            File(androidRoot, "app/src/main/kotlin/one/zephyr/mobile/app/MainActivity.kt").readText(),
        )
        assertTrue(source.contains("enableEdgeToEdge"))
        assertTrue(source.contains("app.ready"))
        assertTrue(source.contains("CircularProgressIndicator"))
        assertFalse(source.contains("runBlocking"))
    }
}
