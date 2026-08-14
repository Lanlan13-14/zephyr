package one.zephyr.mobile.ui.locale

/**
 * Interface languages One actually ships.
 *
 * Demo listed five rows including zh-TW and ja. Product instruction is
 * Chinese + English only, plus follow-system. Stored as the same wire
 * values SettingsRepository already uses (`system` / `zh-Hans` / `en`).
 * Legacy `zh-Hant` / `ja` fall back to follow-system so an old preference
 * does not leave the UI on a language pack that is no longer present.
 */
enum class AppLanguage(
    val code: String,
    val nativeLabel: String,
    val englishLabel: String,
) {
    SYSTEM("system", "跟随系统", "System"),
    ZH_HANS("zh-Hans", "简体中文", "Simplified Chinese"),
    EN("en", "English", "English"),
    ;

    companion object {
        val stored: List<AppLanguage> = entries.toList()

        fun fromStored(value: String?): AppLanguage = when (value) {
            ZH_HANS.code, "zh", "zh-CN", "zh-cn" -> ZH_HANS
            EN.code, "en-US", "en-GB" -> EN
            else -> SYSTEM
        }
    }
}
