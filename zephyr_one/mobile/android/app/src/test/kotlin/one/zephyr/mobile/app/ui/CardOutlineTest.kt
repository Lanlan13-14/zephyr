package one.zephyr.mobile.app.ui

import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

class CardOutlineTest {

    private val androidRoot = File(".").canonicalFile.let { current ->
        generateSequence(current) { it.parentFile }.first {
            File(it, "app/src/main/AndroidManifest.xml").exists()
        }
    }

    @Test
    fun `root list cards do not draw a stroke`() {
        val files = listOf(
            "feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionListScreen.kt",
            "feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ProtocolPickerScreen.kt",
            "feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/LibraryRootScreen.kt",
            "feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolsRootScreen.kt",
            "feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SessionListScreen.kt",
        )
        for (relative in files) {
            val source = File(androidRoot, relative).readText()
            assertFalse(
                relative + " still draws a card stroke",
                source.contains("BorderStroke") || Regex("""\.border\(""").containsMatchIn(source),
            )
        }
        val groupCard = File(
            androidRoot,
            "core-ui/src/main/kotlin/one/zephyr/mobile/ui/component/Widgets.kt",
        ).readText().substringAfter("fun GroupCard").substringBefore("fun SettingsRow")
        assertFalse("GroupCard still draws a stroke", groupCard.contains(".border("))
    }
}
