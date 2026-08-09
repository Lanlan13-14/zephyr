package one.zephyr.mobile.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import one.zephyr.mobile.app.di.AppContainer

/**
 * Process entry point.
 *
 * Holds [AppContainer] rather than a framework DI graph. DEVELOPMENT.md 6 lists exactly one
 * application-scoped object per concern, and a hand-written container makes the construction order
 * visible: the secret store must exist before the database, and the lock must exist before anything
 * that can hold decrypted material. An annotation processor hides that ordering.
 */
class ZephyrOneApplication : Application(), Configuration.Provider {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(LockLifecycleObserver())
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
        }

        override fun onStop(owner: LifecycleOwner) {
            container.appLock.onEnterBackground()
        }
    }
}
