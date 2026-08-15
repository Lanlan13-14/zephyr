package one.zephyr.mobile.app

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import one.zephyr.mobile.ui.theme.ZephyrThemeId

/**
 * The launcher exposes one manifest alias per colour theme. Android cannot mutate an
 * application's icon resource in place, so changing the desktop icon means enabling exactly one
 * alias and disabling the other three.
 *
 * Component overrides survive process death and application updates. The selected theme is still
 * the source of truth in SettingsRepository; MainActivity reapplies it after the active workspace
 * emits its persisted preferences, so an install upgraded from the single-icon build migrates
 * automatically.
 */
internal class LauncherIconController(context: Context) {
    private val appContext = context.applicationContext
    private val packageManager = appContext.packageManager

    fun apply(themeId: ZephyrThemeId): Boolean = runCatching {
        val changes = launcherIconPlan(themeId).filterNot(::alreadyApplied)
        if (changes.isEmpty()) return true

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.setComponentEnabledSettings(
                changes.map { state ->
                    PackageManager.ComponentEnabledSetting(
                        component(state.alias),
                        state.packageManagerState,
                        PackageManager.DONT_KILL_APP,
                    )
                },
            )
        } else {
            // Before API 33 there is no atomic batch call. Enable the destination first so a
            // launcher intent always has a live component, then remove stale aliases.
            changes
                .sortedByDescending { it.enabled }
                .forEach { state ->
                    packageManager.setComponentEnabledSetting(
                        component(state.alias),
                        state.packageManagerState,
                        PackageManager.DONT_KILL_APP,
                    )
                }
        }
        true
    }.getOrElse { error ->
        Log.e(TAG, "Unable to switch launcher icon to ${themeId.wireName}", error)
        false
    }

    private fun alreadyApplied(state: LauncherIconState): Boolean {
        val configured = packageManager.getComponentEnabledSetting(component(state.alias))
        val enabled = when (configured) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED,
            -> false
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> state.alias.enabledByDefault
            else -> false
        }
        return enabled == state.enabled
    }

    private fun component(alias: LauncherIconAlias): ComponentName =
        ComponentName(appContext.packageName, alias.componentClassName)

    private val LauncherIconState.packageManagerState: Int
        get() = if (enabled) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        } else {
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }

    private companion object {
        const val TAG = "ZephyrLauncherIcon"
    }
}

internal enum class LauncherIconAlias(
    val themeId: ZephyrThemeId,
    val componentClassName: String,
    val enabledByDefault: Boolean = false,
) {
    FROST(ZephyrThemeId.FROST, "one.zephyr.mobile.app.FrostLauncher", enabledByDefault = true),
    LAVA(ZephyrThemeId.LAVA, "one.zephyr.mobile.app.LavaLauncher"),
    ASAGI(ZephyrThemeId.ASAGI, "one.zephyr.mobile.app.AsagiLauncher"),
    CYBER(ZephyrThemeId.CYBER, "one.zephyr.mobile.app.CyberLauncher"),
    ;

    companion object {
        fun forTheme(themeId: ZephyrThemeId): LauncherIconAlias =
            entries.single { it.themeId == themeId }
    }
}

internal data class LauncherIconState(
    val alias: LauncherIconAlias,
    val enabled: Boolean,
)

internal fun launcherIconPlan(themeId: ZephyrThemeId): List<LauncherIconState> {
    val selected = LauncherIconAlias.forTheme(themeId)
    return LauncherIconAlias.entries.map { alias ->
        LauncherIconState(alias = alias, enabled = alias == selected)
    }
}
