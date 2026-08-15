package one.zephyr.mobile.protocol.rdp

import java.io.File

/**
 * Process environment FreeRDP 3.30 requires before `freerdp_settings_new`.
 *
 * Android never exports `HOME`. WinPR then returns NULL from `GetKnownPath(KNOWN_PATH_HOME)`,
 * `freerdp_settings_new` fails, `zephyr_rdp_new` returns NULL, and JNI `create()` reports
 * `rdp_session_create_failed` before any TCP packet is sent. Official aFreeRDP does the same
 * `setenv("HOME", filesDir)` in `freerdp_new`.
 */
object RdpAndroidRuntime {

    const val HOME_ENV = "HOME"

    fun installHome(
        filesDir: File,
        setEnv: (name: String, value: String) -> Unit = { name, value -> setProcessEnv(name, value) },
    ): String {
        val path = filesDir.absoluteFile.apply { mkdirs() }.absolutePath
        require(path.isNotBlank()) { "RDP HOME directory is blank" }
        setEnv(HOME_ENV, path)
        return path
    }

    internal fun setProcessEnv(name: String, value: String) {
        val os = Class.forName("android.system.Os")
        val method = os.getMethod("setenv", String::class.java, String::class.java, Boolean::class.javaPrimitiveType)
        method.invoke(null, name, value, true)
    }
}
