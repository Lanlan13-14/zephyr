package one.zephyr.mobile.app

import android.content.Context
import android.content.Intent
import android.net.Uri

/** External destinations surfaced by the About page. */
enum class AboutDestination(val url: String) {
    GITHUB("https://github.com/Lanlan13-14/zephyr"),
    CHECK_UPDATE("https://github.com/Lanlan13-14/zephyr/releases/latest"),
    OPEN_SOURCE_LICENSES("https://github.com/Lanlan13-14/zephyr/blob/main/THIRD_PARTY_NOTICES.md"),
}

/** Launches About actions through Android's browser chooser without retaining an Activity. */
class AboutActionLauncher(context: Context) {
    private val applicationContext = context.applicationContext

    fun open(destination: AboutDestination): Result<Unit> = runCatching {
        applicationContext.startActivity(intentFor(destination))
    }

    fun intentFor(destination: AboutDestination): Intent = Intent(
        Intent.ACTION_VIEW,
        Uri.parse(destination.url),
    ).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
