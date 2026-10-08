package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets

class EditorCoreBridgeTest {
    @Test
    fun openEditSelectionAndSaveUseTheGoCore() {
        val process = ProcessBuilder("go", "run", ".")
            .directory(java.io.File("../../../../../../../editorcore/cmd/editorcore-host"))
            .redirectErrorStream(false)
            .start()
        process.outputStream.bufferedWriter(StandardCharsets.UTF_8).use { writer ->
            val reader = BufferedReader(InputStreamReader(process.inputStream, StandardCharsets.UTF_8))
            EditorCore.callNative = { request ->
                writer.write(request)
                writer.write("\n")
                writer.flush()
                reader.readLine() ?: error("editorcore closed")
            }
            val opened = EditorCore.open("a😀")
            assertEquals(3, opened.text.length.let { codePoints(opened.text) })
            val edited = EditorCore.edit(opened.id, 1, 2, "中", opened.base, opened.extent)
            // The replacement covers scalar range [1,2), so the emoji is removed.
            assertEquals("a中", edited.text)
            val selected = EditorCore.select(edited.id, 0, 2)
            assertEquals(0, selected.base)
            assertEquals(2, selected.extent)
            assertEquals("a中", EditorCore.text(selected.id))
            writer.write("{\"op\":\"shutdown\"}\n")
            writer.flush()
        }
        process.waitFor()
    }

    private fun codePoints(text: String): Int = text.codePointCount(0, text.length)
}
