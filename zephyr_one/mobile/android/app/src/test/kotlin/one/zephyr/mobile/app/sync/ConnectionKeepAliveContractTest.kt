package one.zephyr.mobile.app.sync

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ConnectionKeepAliveContractTest {

    private val androidRoot = File(".").canonicalFile.let { current ->
        generateSequence(current) { it.parentFile }.first {
            File(it, "app/src/main/AndroidManifest.xml").exists()
        }
    }

    @Test
    fun `keep alive is a disclosed dataSync foreground service`() {
        val manifest = File(androidRoot, "app/src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:name=\".app.sync.ConnectionKeepAliveService\""))
        assertTrue(manifest.contains("android:foregroundServiceType=\"dataSync\""))

        val source = File(
            androidRoot,
            "app/src/main/kotlin/one/zephyr/mobile/app/sync/ConnectionKeepAliveService.kt",
        ).readText()
        assertTrue(source.contains("startForeground"))
        assertTrue(source.contains("ACTION_STOP"))
        assertTrue(source.contains("keep_alive_stop"))
        assertTrue(source.contains("setKeepAliveEnabled(false)"))
    }

    @Test
    fun `wake stream hold alive is wired through the account graph`() {
        val wake = File(
            androidRoot,
            "core-sync/src/main/kotlin/one/zephyr/mobile/sync/WakeCoordinator.kt",
        ).readText()
        assertTrue(wake.contains("fun onHoldAliveChanged"))
        assertTrue(wake.contains("foreground || holdAlive"))

        val account = File(
            androidRoot,
            "app/src/main/kotlin/one/zephyr/mobile/app/di/AccountContainer.kt",
        ).readText()
        assertTrue(account.contains("fun startNetworkProducers"))
        assertTrue(account.contains("fun setHoldAlive"))
        assertTrue(account.contains("wakeCoordinator.onHoldAliveChanged"))

        val coordinator = File(
            androidRoot,
            "app/src/main/kotlin/one/zephyr/mobile/app/binding/BindingCoordinator.kt",
        ).readText()
        assertTrue(coordinator.contains("prepared.graph.startNetworkProducers()"))

        val application = File(
            androidRoot,
            "app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneApplication.kt",
        ).readText()
        val afterReady = application.substringAfter("readyState.value = true")
        assertTrue(afterReady.contains("startNetworkProducers"))
        assertTrue(afterReady.contains("ConnectionKeepAliveService.start"))
        assertTrue(afterReady.contains("shouldHoldAlive"))
        assertTrue(
            afterReady.indexOf("ConnectionKeepAliveService.start") <
                afterReady.indexOf("startNetworkProducers"),
        )
    }
}
