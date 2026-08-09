package one.zephyr.mobile.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.fragment.app.FragmentActivity
import one.zephyr.mobile.security.LockState
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * The single Activity.
 *
 * A [FragmentActivity] rather than a ComponentActivity because BiometricPrompt requires one, and
 * app lock is not optional enough to justify a second activity just to host it.
 *
 * windowSoftInputMode is adjustNothing, set in the manifest rather than here: the terminal and the
 * remote surface size themselves from the IME insets they observe, and letting the framework resize
 * or pan the window would fight that and reflow the PTY on every keystroke.
 */
class MainActivity : FragmentActivity() {

    private val container get() = (application as ZephyrOneApplication).container

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            val lockState by container.appLock.state.collectAsState()
            ZephyrTheme {
                ZephyrOneRoot(
                    container = container,
                    locked = lockState == LockState.LOCKED,
                    onUnlockRequested = { container.deviceAuthenticator.attach(this) },
                )
            }
        }
    }

    /**
     * Screenshot protection, applied per resume rather than once.
     *
     * The user can toggle it in S50 while the app is running, and FLAG_SECURE only takes effect on
     * the window it is set on, so a value read once at creation would silently stop matching the
     * setting.
     */
    override fun onResume() {
        super.onResume()
        container.deviceAuthenticator.attach(this)
        applyScreenshotProtection()
    }

    override fun onPause() {
        // Detached here, not in onDestroy: a paused activity cannot host a prompt, and holding the
        // reference across a rotation is what leaks it.
        container.deviceAuthenticator.detach(this)
        super.onPause()
    }

    private fun applyScreenshotProtection() {
        val protect = getSharedPreferences(PREFS_APPEARANCE, MODE_PRIVATE)
            .getBoolean(KEY_SCREENSHOT_PROTECTION, false)
        if (protect) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    private companion object {
        const val PREFS_APPEARANCE = "zephyr-one-appearance"
        const val KEY_SCREENSHOT_PROTECTION = "screenshot-protection"
    }
}
