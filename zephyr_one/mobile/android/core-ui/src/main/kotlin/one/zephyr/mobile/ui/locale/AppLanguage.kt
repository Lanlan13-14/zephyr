package one.zephyr.mobile.ui.locale

/**
 * Interface languages frozen by demo.html.
 */
enum class AppLanguage(
    val code: String,
    val nativeLabel: String,
    val englishLabel: String,
) {
    SYSTEM("system", "跟随系统", "System"),
    ZH_HANS("zh-Hans", "简体中文", "Simplified Chinese"),
    ZH_HANT("zh-Hant", "繁體中文", "Traditional Chinese"),
    EN("en", "English", "English"),
    ;

    companion object {
        val stored: List<AppLanguage> = entries.toList()

        fun fromStored(value: String?): AppLanguage = when (value) {
            ZH_HANS.code, "zh", "zh-CN", "zh-cn" -> ZH_HANS
            ZH_HANT.code, "zh-TW", "zh-tw", "zh-HK", "zh-hk" -> ZH_HANT
            EN.code, "en-US", "en-GB" -> EN
            else -> SYSTEM
        }
    }
}
