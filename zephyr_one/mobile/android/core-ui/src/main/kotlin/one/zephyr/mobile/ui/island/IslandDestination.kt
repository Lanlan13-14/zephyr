package one.zephyr.mobile.ui.island

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.ui.graphics.vector.ImageVector
import one.zephyr.mobile.ui.R

/**
 * The four root destinations.
 *
 * Frozen as exactly four, in this order, by DEVELOPMENT.md 6.1: 首页 / 会话 / 资料 / 工具. AI is
 * deliberately absent - it is a tool entry and a page-level action, never a fifth slot - and so is
 * anything from the excluded management surface. Modelling them as an enum rather than a list the
 * caller supplies is what stops a feature module from quietly adding a slot.
 */
enum class IslandDestination(
    val route: String,
    /**
     * Short label, as a resource rather than a literal.
     *
     * SCREEN_CATALOG.md 26 requires zh and en coverage, and a hardcoded string here cannot be
     * translated by adding values-en/: the enum is loaded before any Context exists. The island only
     * ever shows one line, so the resource is expected to stay two characters wide in zh.
     */
    @StringRes val labelRes: Int,
    val icon: ImageVector,
) {
    HOME("home", R.string.island_home, Icons.Outlined.Home),
    SESSIONS("sessions", R.string.island_sessions, Icons.Outlined.Terminal),
    LIBRARY("library", R.string.island_library, Icons.Outlined.Folder),
    TOOLS("tools", R.string.island_tools, Icons.Outlined.GridView),
    ;

    companion object {
        val ordered: List<IslandDestination> = entries.toList()

        fun fromRoute(route: String?): IslandDestination? = entries.firstOrNull { it.route == route }
    }
}
