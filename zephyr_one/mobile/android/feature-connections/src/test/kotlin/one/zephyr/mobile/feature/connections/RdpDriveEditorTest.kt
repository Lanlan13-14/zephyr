package one.zephyr.mobile.feature.connections

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * RDP folder mapping belongs on the connection editor, not a settings page.
 *
 * Zephyr Agent picks a directory on the same screen that owns the mapping.
 * One used to cycle FileSyncDirectoryIntent labels, which never authorised a
 * tree and sent people hunting through 工具 → 文件同步.
 */
class RdpDriveEditorTest {

    private val screen = File(
        "src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt",
    ).readText()

    @Test
    fun `editor picks a directory instead of cycling intent labels`() {
        assertTrue(screen.contains("EditorIntent.PickDriveDirectory"))
        assertTrue(screen.contains("点这里选本机目录"))
        assertFalse(screen.contains("values[(current + 1) % values.size]"))
        assertFalse(screen.contains("下载/ZephyrDrive"))
    }

    @Test
    fun `storage toggle lives on the RDP connection, not a tools page`() {
        assertTrue(screen.contains("文件夹映射"))
        assertTrue(screen.contains("EditorIntent.ClearDriveDirectory"))
        assertTrue(screen.contains("授予所有文件访问权限"))
    }
}
