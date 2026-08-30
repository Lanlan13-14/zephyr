package one.zephyr.mobile.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import androidx.work.WorkManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.di.AppContainer
import one.zephyr.mobile.protocol.rdp.RdpAndroidRuntime

/**
 * Process entry point.
 *
 * Holds [AppContainer] rather than a framework DI graph. DEVELOPMENT.md 6 lists exactly one
 * application-scoped object per concern, and a hand-written container makes the construction order
 * visible: the secret store must exist before the database, and the lock must exist before anything
 * that can hold decrypted material. An annotation processor hides that ordering.
 *
 * Recovery used to run inside three `runBlocking` calls on the main thread. That is the black
 * screen the user sees on launch: Application.onCreate finishes only after journal replay, binding
 * restore and local-workspace open all return, and the window theme was solid black until then.
 * Recovery still happens first relative to WorkManager and any Activity *use* of the account, but
 * it now runs on Dispatchers.IO while MainActivity paints a splash-coloured first frame.
 */
class ZephyrOneApplication : Application(), Configuration.Provider {

    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        /** Restore must never wedge the ready gate: bound it well below any user patience. */
        private const val BINDING_RESTORE_TIMEOUT_MS = 20_000L
        /** Local workspace open is pure local I/O; 15s means something is truly wrong. */
        private const val WORKSPACE_OPEN_TIMEOUT_MS = 15_000L
    }

    lateinit var container: AppContainer
        private set

    private val readyState = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = readyState.asStateFlow()

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        WorkManager.initialize(this, workManagerConfiguration)
        ProcessLifecycleOwner.get().lifecycle.addObserver(LockLifecycleObserver())
        applicationScope.launch {
            // RDP home is a process env write. It is not needed to paint the dashboard, so it
            // stays off the first-frame path and only has to land before an RDP session opens.
            runCatching { RdpAndroidRuntime.installHome(filesDir) }
            try {
                // Pending password/TOTP state is process-local and cannot resume after death. Clear
                // its durable crumbs off Main together with the rest of startup recovery.
                container.clearPendingBindingAuthentication()
                runCatching { container.bindingCoordinator.completePendingTeardown() }
                // A database tombstone can outlive its journal if the process died after the journal clear.
                runCatching { container.sweepErasedAccountDatabases() }
                // White-screen insurance: the ready gate below ONLY flips when this block reaches its
                // end. A restore that hangs (coordinator mutex held by a stuck sync round, a wedged
                // keystore, a wedged DB) would otherwise keep the app on a blank frame across restarts.
                // TimeoutCancellationException is expected recovery here, not process cancellation.
                try {
                    withTimeout(BINDING_RESTORE_TIMEOUT_MS) {
                        container.bindingCoordinator.restoreActiveBinding(bootstrap = false)
                    }
                } catch (timeout: TimeoutCancellationException) {
                    android.util.Log.e("ZephyrOneApp", "binding restore timed out", timeout)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    android.util.Log.e("ZephyrOneApp", "binding restore failed", failure)
                }

                // Local-first: an unbound device still opens a fully usable workspace. Sync is optional
                // on mobile, so the app must never be unusable just because no server binding is present.
                val workspace = try {
                    withTimeout(WORKSPACE_OPEN_TIMEOUT_MS) { container.ensureLocalWorkspace() }
                } catch (timeout: TimeoutCancellationException) {
                    android.util.Log.e("ZephyrOneApp", "workspace open timed out", timeout)
                    null
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    android.util.Log.e("ZephyrOneApp", "workspace open failed", failure)
                    null
                }
                if (workspace != null && workspace.isLocalMode) {
                    runCatching { workspace.activate() }
                }
            } finally {
                // No recovery failure may leave MainActivity on its same-colour placeholder forever.
                readyState.value = true
            }
            // Sockets, wake, Link and the first sync round stay off the ready gate. The dashboard
            // can paint from the restored mirror; producers catch up after the first frame.
            if (container.shouldHoldAlive()) {
                one.zephyr.mobile.app.sync.ConnectionKeepAliveService.start(this@ZephyrOneApplication)
            }
            if (!container.isLocalMode) {
                runCatching { container.account?.startNetworkProducers() }
                runCatching { container.bindingCoordinator.bootstrapRestoredBinding() }
            }
        }
    }

    /**
     * WorkManager is configured here rather than by its default initialiser.
     *
     * The sync worker needs the container, and the only way to hand it one without a static is to
     * own the factory. Default initialisation is disabled in the manifest to stop two WorkManagers
     * racing for the same database.
     */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()

    /**
     * Drives [one.zephyr.mobile.security.AppLock] from the process lifecycle.
     *
     * Process lifecycle, not activity lifecycle: a rotation destroys and recreates the activity, and
     * locking on that would lock the app every time the user turned the phone.
     */
    private inner class LockLifecycleObserver : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            container.appLock.onEnterForeground()
            container.onProcessForeground()
        }

        override fun onStop(owner: LifecycleOwner) {
            container.onProcessBackground()
            container.appLock.onEnterBackground()
        }
    }
}
