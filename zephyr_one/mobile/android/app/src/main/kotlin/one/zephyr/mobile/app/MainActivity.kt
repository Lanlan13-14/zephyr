package one.zephyr.mobile.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.security.LockDelay
import one.zephyr.mobile.security.LockState
import one.zephyr.mobile.ui.theme.ZephyrPalette
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.theme.ZephyrThemeId

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

    private val app get() = application as ZephyrOneApplication
    private val container get() = app.container

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT,
            ),
            navigationBarStyle = SystemBarStyle.auto(
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT,
            ),
        )
        super.onCreate(savedInstanceState)

        setContent {
            val ready by app.ready.collectAsState()
            val lockState by container.appLock.state.collectAsState()
            val account by container.accounts.collectAsState()
            val themePrefs by remember(account) {
                account?.settings?.observePreferences()?.map(::appearanceFromPrefs)
                    ?: flowOf(AppearancePrefs())
            }.collectAsState(initial = AppearancePrefs())
            val systemDark = isSystemInDarkTheme()
            val dark = when (themePrefs.mode) {
                AppearanceMode.LIGHT -> false
                AppearanceMode.DARK -> true
                AppearanceMode.AUTO -> systemDark
            }

            LaunchedEffect(themePrefs.lockEnabled, themePrefs.lockTimeout) {
                applyAppLock(themePrefs)
            }
            LaunchedEffect(themePrefs.screenshotGuard) {
                persistScreenshotFlag(themePrefs.screenshotGuard)
                applyScreenshotProtection()
            }

            ZephyrTheme(themeId = themePrefs.themeId, dark = dark) {
                if (!ready) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(ZephyrPalette.of(themePrefs.themeId, dark).surfaces.background),
                    )
                } else {
                    ZephyrOneRoot(
                        container = container,
                        locked = lockState == LockState.LOCKED,
                        onUnlockRequested = { container.deviceAuthenticator.attach(this) },
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        container.deviceAuthenticator.attach(this)
        applyScreenshotProtection()
        if (app.ready.value) revalidateFileShares()
    }

    private fun revalidateFileShares() {
        container.account?.pruneRevokedShares()
    }

    override fun onPause() {
        container.deviceAuthenticator.detach(this)
        super.onPause()
    }

    private fun applyAppLock(prefs: AppearancePrefs) {
        val lock = container.appLock
        if (!prefs.lockEnabled) {
            if (lock.isEnabled) lock.disable()
            return
        }
        if (!lock.isEnabled) lock.enable(prefs.lockTimeout)
        else lock.setDelay(prefs.lockTimeout)
    }

    private fun persistScreenshotFlag(enabled: Boolean) {
        getSharedPreferences(PREFS_APPEARANCE, MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_SCREENSHOT_PROTECTION, enabled)
            .apply()
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

internal enum class AppearanceMode { AUTO, LIGHT, DARK }

internal data class AppearancePrefs(
    val themeId: ZephyrThemeId = ZephyrThemeId.default,
    val mode: AppearanceMode = AppearanceMode.AUTO,
    val lockEnabled: Boolean = false,
    val lockTimeout: LockDelay = LockDelay.default,
    val screenshotGuard: Boolean = false,
)

internal fun appearanceFromPrefs(prefs: Map<String, JsonObject>): AppearancePrefs {
    fun text(key: String, fallback: String): String =
        prefs[key]?.let { EntityCodec.string(it, "value") } ?: fallback

    fun flag(key: String, fallback: Boolean): Boolean =
        prefs[key]?.let { EntityCodec.bool(it, "value", fallback) } ?: fallback

    return AppearancePrefs(
        themeId = ZephyrThemeId.fromWire(text(SettingsRepository.PREF_THEME, ZephyrThemeId.default.wireName)),
        mode = when (text(SettingsRepository.PREF_AUTO_THEME, "auto")) {
            "light" -> AppearanceMode.LIGHT
            "dark" -> AppearanceMode.DARK
            else -> AppearanceMode.AUTO
        },
        lockEnabled = flag(SettingsRepository.PREF_APP_LOCK_ENABLED, false),
        lockTimeout = when (text(SettingsRepository.PREF_APP_LOCK_TIMEOUT, "immediate")) {
            "1m" -> LockDelay.ONE_MINUTE
            "5m" -> LockDelay.FIVE_MINUTES
            else -> LockDelay.IMMEDIATE
        },
        screenshotGuard = flag(SettingsRepository.PREF_SCREENSHOT_GUARD, false),
    )
}
