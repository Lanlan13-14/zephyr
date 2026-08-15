package one.zephyr.mobile.protocol.rdp

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RdpAndroidRuntimeTest {

    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun `installHome exports filesDir as HOME and creates the directory`() {
        val files = File(folder.root, "files")
        val env = mutableMapOf<String, String>()

        val path = RdpAndroidRuntime.installHome(files) { name, value -> env[name] = value }

        assertTrue(files.isDirectory)
        assertEquals(files.absolutePath, path)
        assertEquals(files.absolutePath, env[RdpAndroidRuntime.HOME_ENV])
    }
}
