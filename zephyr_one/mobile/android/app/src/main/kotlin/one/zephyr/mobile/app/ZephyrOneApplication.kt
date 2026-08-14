package one.zephyr.mobile.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.di.AppContainer

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

    lateinit var container: AppContainer
        private set

    private val readyState = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = readyState.asStateFlow()

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.clearPendingBindingAuthentication()
        WorkManager.initialize(this, workManagerConfiguration)
        ProcessLifecycleOwner.get().lifecycle.addObserver(LockLifecycleObserver())
        applicationScope.launch {
            runCatching { container.bindingCoordinator.completePendingTeardown() }
            // A database tombstone can outlive its journal if the process died after the journal clear.
            runCatching { container.sweepErasedAccountDatabases() }
            runCatching { container.bindingCoordinator.restoreActiveBinding(bootstrap = false) }
            // Local-first: an unbound device still opens a fully usable workspace. Sync is optional
            // on mobile, so the app must never be unusable just because no server binding is present.
            val workspace = runCatching { container.ensureLocalWorkspace() }
                .recoverCatching { container.ensureLocalWorkspace() }
                .getOrNull()
            if (workspace != null && workspace.isLocalMode) {
                runCatching { workspace.activate() }
            }
            if (!container.isLocalMode) {
                launch {
                    runCatching { container.bindingCoordinator.bootstrapRestoredBinding() }
                }
            }
            readyState.value = true
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
