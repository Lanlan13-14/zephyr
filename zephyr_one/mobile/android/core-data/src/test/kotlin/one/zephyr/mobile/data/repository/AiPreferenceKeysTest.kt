package one.zephyr.mobile.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AiPreferenceKeysTest {

    @Test
    fun `ai preferences are device local keys`() {
        val keys = listOf(
            SettingsRepository.PREF_AI_ENABLED,
            SettingsRepository.PREF_AI_PROVIDER,
            SettingsRepository.PREF_AI_MODEL,
            SettingsRepository.PREF_AI_COLLAB,
            SettingsRepository.PREF_AI_PERM,
            SettingsRepository.PREF_AI_THINK,
            SettingsRepository.PREF_AI_TOOL_ROUNDS,
            SettingsRepository.PREF_AI_CONFIRM,
            SettingsRepository.PREF_AI_MEMORY,
            SettingsRepository.PREF_AI_MEMORY_CAP,
            SettingsRepository.PREF_AI_PLANNER,
            SettingsRepository.PREF_AI_SKILLS,
            SettingsRepository.PREF_AI_ENV_NAMES,
            SettingsRepository.PREF_AI_ENV_VALUES,
        )
        assertEquals(14, keys.size)
        assertTrue(keys.all { it.startsWith("one.ai.") })
    }
}
