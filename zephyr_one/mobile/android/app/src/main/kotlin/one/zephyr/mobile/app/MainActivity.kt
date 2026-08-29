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
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.R
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.security.AppLockPreferences
import one.zephyr.mobile.security.AuthResult
import one.zephyr.mobile.security.LockDelay
import one.zephyr.mobile.security.LockState
import one.zephyr.mobile.ui.component.CircularProgressIndicator
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
        // Attach before the first composition. LockGate launches the platform prompt on the
        // first RESUMED; if the host is still null that attempt dies as "没有可用的界面".
        container.deviceAuthenticator.attach(this)
        restoreLockFromCache()

        setContent {
            val ready by app.ready.collectAsState()
            val lockState by container.appLock.state.collectAsState()
            val account by container.accounts.collectAsState()
            val cachedAppearance = remember { appearanceFromLockCache() }
            val loadedThemePrefs by remember(account) {
                account?.settings?.observePreferences()?.map { appearanceFromPrefs(it) }
                    ?: flowOf(null)
            }.collectAsState(initial = null)
            val themePrefs = loadedThemePrefs ?: cachedAppearance
            val languageCode by remember(account) {
                account?.settings?.observePreferences()?.map { prefs ->
                    prefs[SettingsRepository.PREF_LANGUAGE]?.let { EntityCodec.string(it, "value") }
                } ?: flowOf(null)
            }.collectAsState(initial = null)
            val systemDark = isSystemInDarkTheme()
            val dark = when (themePrefs.mode) {
                AppearanceMode.LIGHT -> false
                AppearanceMode.DARK -> true
                AppearanceMode.AUTO -> systemDark
            }

            LaunchedEffect(ready, account, loadedThemePrefs?.themeId) {
                // Wait until Room has emitted the active workspace's real preference instead of
                // briefly forcing Frost while startup is still loading Lava/Asagi/Cyber.
                if (ready && account != null) {
                    loadedThemePrefs?.let { container.launcherIcons.apply(it.themeId) }
                }
            }
            LaunchedEffect(languageCode) {
                LocaleController.applyIfNeeded(this@MainActivity, languageCode)
            }
            LaunchedEffect(themePrefs.lockEnabled, themePrefs.lockTimeout) {
                applyAppLock(themePrefs, lockOnEnable = false)
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
                        contentAlignment = androidx.compose.ui.Alignment.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp))
                    }
                } else {
                    ZephyrOneRoot(
                        container = container,
                        locked = lockState == LockState.LOCKED,
                        onUnlockRequested = { requestPlatformUnlock() },
                    )
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Restore from the synchronous cache before the first visible frame. Room
        // preferences arrive later and only refine the delay / disable path.
        restoreLockFromCache()
        container.deviceAuthenticator.attach(this)
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

    override fun onDestroy() {
        container.deviceAuthenticator.detach(this)
        super.onDestroy()
    }

    private fun appearancePrefsStore() =
        getSharedPreferences(AppLockCache.PREFS, MODE_PRIVATE)

    private fun restoreLockFromCache() {
        val store = appearancePrefsStore()
        applyAppLock(
            enabled = AppLockCache.readEnabled(store),
            delay = AppLockCache.readDelay(store),
            lockOnEnable = true,
        )
    }

    private fun appearanceFromLockCache(): AppearancePrefs {
        val store = appearancePrefsStore()
        val recorded = store.contains(AppLockCache.KEY_ENABLED)
        return AppearancePrefs(
            lockEnabled = AppLockCache.readEnabled(store),
            lockTimeout = AppLockCache.readDelay(store),
            screenshotGuard = store.getBoolean(KEY_SCREENSHOT_PROTECTION, false),
            lockRecorded = recorded,
        )
    }

    private fun applyAppLock(prefs: AppearancePrefs, lockOnEnable: Boolean) {
        if (!shouldApplyLockPreference(prefs)) return
        applyAppLock(
            enabled = prefs.lockEnabled,
            delay = prefs.lockTimeout,
            lockOnEnable = shouldLockWhenApplying(container.appLock.isEnabled, prefs.lockEnabled, lockOnEnable),
        )
        persistAppLockCache(prefs.lockEnabled, prefs.lockTimeout)
    }

    private fun applyAppLock(enabled: Boolean, delay: LockDelay, lockOnEnable: Boolean) {
        AppLockPreferences.apply(
            lock = container.appLock,
            enabled = enabled,
            delay = delay,
            lockOnEnable = lockOnEnable,
        )
    }

    private fun persistAppLockCache(enabled: Boolean, delay: LockDelay) {
        AppLockCache.write(appearancePrefsStore(), enabled, delay)
    }

    /**
     * Hosts the platform prompt. attach is not enough: BiometricPrompt only appears after
     * [one.zephyr.mobile.security.AppLock.unlock] asks the authenticator.
     */
    private suspend fun requestPlatformUnlock(): AuthResult {
        container.deviceAuthenticator.attach(this)
        return container.appLock.unlock(
            title = getString(R.string.unlock_title),
            subtitle = getString(R.string.unlock_subtitle),
        )
    }

    private fun persistScreenshotFlag(enabled: Boolean) {
        appearancePrefsStore()
            .edit()
            .putBoolean(KEY_SCREENSHOT_PROTECTION, enabled)
            .apply()
    }

    private fun applyScreenshotProtection() {
        val protect = appearancePrefsStore()
            .getBoolean(KEY_SCREENSHOT_PROTECTION, false)
        if (protect) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    private companion object {
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
    val lockRecorded: Boolean = false,
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
        lockRecorded = SettingsRepository.PREF_APP_LOCK_ENABLED in prefs,
    )
}

/**
 * An empty Room table is not "the user turned the lock off". Applying that would disable a
 * cache-restored lock and then persist false over the cache.
 */
internal fun shouldApplyLockPreference(prefs: AppearancePrefs): Boolean =
    prefs.lockRecorded || prefs.lockEnabled

/**
 * Enabling from settings leaves the session unlocked. Restoring the same flag onto a process
 * that has not enabled yet must lock immediately, or the dashboard flashes first.
 */
internal fun shouldLockWhenApplying(
    alreadyEnabled: Boolean,
    enabled: Boolean,
    lockOnEnable: Boolean,
): Boolean = lockOnEnable || (!alreadyEnabled && enabled)
