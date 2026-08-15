package one.zephyr.mobile.app

import one.zephyr.mobile.ui.theme.ZephyrThemeId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LauncherIconControllerTest {

    @Test
    fun `every colour theme owns one launcher alias`() {
        assertEquals(ZephyrThemeId.entries.toSet(), LauncherIconAlias.entries.map { it.themeId }.toSet())
        assertEquals(LauncherIconAlias.FROST, LauncherIconAlias.forTheme(ZephyrThemeId.FROST))
        assertEquals(LauncherIconAlias.LAVA, LauncherIconAlias.forTheme(ZephyrThemeId.LAVA))
        assertEquals(LauncherIconAlias.ASAGI, LauncherIconAlias.forTheme(ZephyrThemeId.ASAGI))
        assertEquals(LauncherIconAlias.CYBER, LauncherIconAlias.forTheme(ZephyrThemeId.CYBER))
    }

    @Test
    fun `each plan enables only the selected launcher`() {
        ZephyrThemeId.entries.forEach { selectedTheme ->
            val plan = launcherIconPlan(selectedTheme)
            assertEquals(LauncherIconAlias.entries.size, plan.size)
            assertEquals(1, plan.count { it.enabled })
            assertEquals(selectedTheme, plan.single { it.enabled }.alias.themeId)
            assertTrue(plan.filterNot { it.enabled }.all { it.alias.themeId != selectedTheme })
        }
    }

    @Test
    fun `only frost is enabled by manifest default`() {
        assertTrue(LauncherIconAlias.FROST.enabledByDefault)
        assertTrue(LauncherIconAlias.entries.filterNot { it == LauncherIconAlias.FROST }.none { it.enabledByDefault })
    }

    @Test
    fun `aliases resolve to manifest component class names`() {
        LauncherIconAlias.entries.forEach { alias ->
            assertTrue(alias.componentClassName.startsWith("one.zephyr.mobile.app."))
            assertTrue(alias.componentClassName.endsWith("Launcher"))
            assertFalse(alias.componentClassName.contains(".debug."))
        }
        assertEquals(LauncherIconAlias.entries.size, LauncherIconAlias.entries.map { it.componentClassName }.toSet().size)
    }
}
