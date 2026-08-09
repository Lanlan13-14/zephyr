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
        revalidateFileShares()
    }

    /**
     * Re-checks the authorised directories every time the app comes forward.
     *
     * DEVELOPMENT.md 13.5 requires the binding and the file-bridge lease to be re-verified before
     * reconnecting, and a SAF grant is revocable system state: the user can withdraw it in system
     * settings, clear the app's data, or remove the SD card the tree lived on, and nothing notifies
     * the app. A row that survived that would advertise a share the provider cannot open, so the
     * failure would surface as a broken drive mid-session rather than a directory that needs
     * re-picking.
     *
     * Here rather than in a Composable effect because it must run even when no remote session is on
     * screen: the stale row is what the *next* connection would resolve, and the connection editor
     * reads the same rows to show which directory is selected.
     *
     * Silent by design. There is no snackbar host at this level, and the honest reports are the ones
     * the affected screens already make: a pruned choice makes the drive resolve to
     * NeedsUserChoice, which prompts.
     */
    private fun revalidateFileShares() {
        container.account?.pruneRevokedShares()
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
