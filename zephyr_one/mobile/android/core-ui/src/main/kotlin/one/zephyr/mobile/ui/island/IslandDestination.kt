package one.zephyr.mobile.ui.island

import androidx.annotation.StringRes
import androidx.compose.ui.graphics.vector.ImageVector
import one.zephyr.mobile.ui.R
import one.zephyr.mobile.ui.icon.ZephyrIcons

/**
 * The four root destinations, frozen as 首页 / 会话 / 资料 / 工具.
 * Icons are the stroked SVGs from demo.html `#island`, not Material Icons.
 */
enum class IslandDestination(
    val route: String,
    @StringRes val labelRes: Int,
    val icon: ImageVector,
) {
    HOME("home", R.string.island_home, ZephyrIcons.Home),
    SESSIONS("sessions", R.string.island_sessions, ZephyrIcons.Sessions),
    LIBRARY("library", R.string.island_library, ZephyrIcons.Library),
    TOOLS("tools", R.string.island_tools, ZephyrIcons.Tools),
    ;

    companion object {
        val ordered: List<IslandDestination> = entries.toList()

        fun fromRoute(route: String?): IslandDestination? = entries.firstOrNull { it.route == route }
    }
}
