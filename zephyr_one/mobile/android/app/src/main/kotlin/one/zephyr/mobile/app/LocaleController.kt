package one.zephyr.mobile.app

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import one.zephyr.mobile.ui.locale.AppLanguage
import java.util.Locale

/**
 * Applies [AppLanguage] on this device only.
 *
 * Android 13+ writes the per-app locale through LocaleManager. Older
 * releases update the application configuration in place. The main end
 * never owns this preference.
 */
object LocaleController {

    fun apply(context: Context, language: AppLanguage) {
        val locales = when (language) {
            AppLanguage.SYSTEM -> LocaleList.getEmptyLocaleList()
            AppLanguage.ZH_HANS -> LocaleList.forLanguageTags("zh-CN")
            AppLanguage.ZH_HANT -> LocaleList.forLanguageTags("zh-TW")
            AppLanguage.EN -> LocaleList.forLanguageTags("en")
        }
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
}
