package one.zephyr.mobile.app

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import one.zephyr.mobile.ui.locale.AppLanguage
import one.zephyr.mobile.ui.locale.LocaleApplyPolicy
import java.util.Locale

/**
 * Applies [AppLanguage] on this device only.
 *
 * Android 13+ writes the per-app locale through LocaleManager. Older
 * releases update the application configuration in place. The main end
 * never owns this preference.
 *
 * Writing the same LocaleList again recreates the Activity. Callers must
 * go through [applyIfNeeded] so a first-frame "system" collect cannot loop.
 */
object LocaleController {

    fun applied(context: Context): AppLanguage {
        if (Build.VERSION.SDK_INT >= 33) {
            val tags = context.getSystemService(LocaleManager::class.java)
                .applicationLocales
                .toLanguageTags()
            return AppLanguage.fromLocaleTags(tags)
        }
        val tags = context.applicationContext.resources.configuration.locales.toLanguageTags()
        return AppLanguage.fromLocaleTags(tags)
    }

    fun applyIfNeeded(context: Context, stored: String?): Boolean {
        val pending = LocaleApplyPolicy.pending(stored, applied(context)) ?: return false
        apply(context, pending)
        return true
    }

    fun apply(context: Context, language: AppLanguage) {
        if (applied(context) == language) return
        val locales = localesFor(language)
        if (Build.VERSION.SDK_INT >= 33) {
            context.getSystemService(LocaleManager::class.java).applicationLocales = locales
            return
        }
        val config = Configuration(context.applicationContext.resources.configuration)
        if (locales.isEmpty) {
            config.setLocales(LocaleList.getAdjustedDefault())
        } else {
            Locale.setDefault(locales[0])
            config.setLocales(locales)
        }
        @Suppress("DEPRECATION")
        context.applicationContext.resources.updateConfiguration(config, context.resources.displayMetrics)
    }

    internal fun localesFor(language: AppLanguage): LocaleList = when (language) {
        AppLanguage.SYSTEM -> LocaleList.getEmptyLocaleList()
        AppLanguage.ZH_HANS -> LocaleList.forLanguageTags("zh-CN")
        AppLanguage.ZH_HANT -> LocaleList.forLanguageTags("zh-TW")
        AppLanguage.EN -> LocaleList.forLanguageTags("en")
    }
}
