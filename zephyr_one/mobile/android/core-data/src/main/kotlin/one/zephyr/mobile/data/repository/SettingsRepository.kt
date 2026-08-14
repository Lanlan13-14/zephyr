package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.db.DevicePreferenceRow
import one.zephyr.mobile.data.db.ZephyrDatabase

/**
 * Settings, split three ways.
 *
 *  - oneUserSettings / serverSettings are synced entities keyed by section, so they go through the
 *    write gateway like any other row.
 *  - device preferences (language, app lock, screenshot guard, download directory) are local-only
 *    and never enter a fieldMask.
 *  - excluded scopes (account security, SMTP, CAPTCHA, IP policy, 备案, custom CSS/JS, multi-user
 *    admin) are absent by design: PRODUCT_REQUIREMENTS.md 3.2 keeps them out of One entirely, and
 *    [assertEditableScope] makes an accidental reintroduction fail loudly.
 */
class SettingsRepository(
    private val db: ZephyrDatabase,
    private val gateway: LocalWriteGateway,
) {

    fun observeSection(entityType: String, sectionKey: String): Flow<JsonObject> =
        db.mirrorDao().observe(entityType, sectionKey).map { row ->
            row?.let { EntityCodec.parse(it.payloadJson) } ?: JsonObject(emptyMap())
        }

    suspend fun section(entityType: String, sectionKey: String): JsonObject =
        db.mirrorDao().find(entityType, sectionKey)?.let { EntityCodec.parse(it.payloadJson) }
            ?: JsonObject(emptyMap())

    /**
     * @param dottedKeys section-qualified keys such as "appearance.theme". The registry lists them
     *   in that exact form, so they are passed through unchanged rather than flattened.
     */
    suspend fun updateSection(
        entityType: String,
        sectionKey: String,
        dottedKeys: List<String>,
        values: JsonObject,
        ownerUserId: String,
    ) {
        for (key in dottedKeys) assertEditableScope(key)
        gateway.apply(
            LocalEdit(
                entityType = entityType,
                entityId = sectionKey,
                action = SyncAction.UPSERT,
                requestedMask = dottedKeys,
                values = values,
            ),
            ownerUserId,
        )
    }

    /**
     * Fails fast when a caller tries to edit a scope One does not own.
     *
     * This is a real guard rather than documentation: the excluded scopes are main-end-only
     * (账号安全, SMTP, CAPTCHA, IP 策略, 备案, 自定义 CSS/JS, 多用户管理), and a mask naming one of them
     * would be a product regression the release checklist explicitly blocks.
     */
    fun assertEditableScope(dottedKey: String) {
        val scope = dottedKey.substringBefore('.')
        require(EntityRegistry.isEditableScope(scope)) {
            "scope " + scope + " is main-end only and must not be edited from Zephyr One"
        }
    }

    // ---- device-local preferences --------------------------------------------------------------

    fun observePreferences(): Flow<Map<String, JsonObject>> =
        db.devicePreferenceDao().observeAll().map { rows ->
            rows.associate { row -> row.key to EntityCodec.parse(row.valueJson) }
        }

    suspend fun preference(key: String): JsonObject? =
        db.devicePreferenceDao().find(key)?.let { EntityCodec.parse(it.valueJson) }

    suspend fun putPreference(key: String, value: JsonObject, nowMs: Long) {
        db.devicePreferenceDao().upsert(
            DevicePreferenceRow(key = key, valueJson = EntityCodec.encode(value), updatedAt = nowMs),
        )
    }

    suspend fun putStringPreference(key: String, value: String, nowMs: Long) {
        putPreference(key, JsonObject(mapOf("value" to JsonPrimitive(value))), nowMs)
    }

    suspend fun putBooleanPreference(key: String, value: Boolean, nowMs: Long) {
        putPreference(key, JsonObject(mapOf("value" to JsonPrimitive(value))), nowMs)
    }

    suspend fun booleanPreference(key: String, fallback: Boolean): Boolean =
        preference(key)?.let { EntityCodec.bool(it, "value", fallback) } ?: fallback

    suspend fun stringPreference(key: String, fallback: String): String =
        preference(key)?.let { EntityCodec.string(it, "value") } ?: fallback

    companion object {
        const val PREF_LANGUAGE = "one.language"
        const val PREF_APP_LOCK_ENABLED = "one.appLock.enabled"
        const val PREF_APP_LOCK_TIMEOUT = "one.appLock.timeout"
        const val PREF_SCREENSHOT_GUARD = "one.screenshotGuard"
        const val PREF_CELLULAR_POLICY = "one.cellularPolicy"
        const val PREF_DOWNLOAD_DIRECTORY = "one.downloadDirectory"
        const val PREF_THEME = "one.theme"
        const val PREF_AUTO_THEME = "one.autoTheme"
        const val PREF_REDUCE_MOTION_OVERRIDE = "one.reduceMotion"
        const val PREF_AI_ENABLED = "one.ai.enabled"
        const val PREF_AI_PROVIDER = "one.ai.provider"
        const val PREF_AI_MODEL = "one.ai.model"
        const val PREF_AI_COLLAB = "one.ai.collab"
        const val PREF_AI_PERM = "one.ai.perm"
        const val PREF_AI_THINK = "one.ai.think"
        const val PREF_AI_TOOL_ROUNDS = "one.ai.toolRounds"
        const val PREF_AI_CONFIRM = "one.ai.confirmSensitive"
        const val PREF_AI_MEMORY = "one.ai.memory"
        const val PREF_AI_MEMORY_CAP = "one.ai.memoryCap"
        const val PREF_AI_PLANNER = "one.ai.planner"
        const val PREF_AI_SKILLS = "one.ai.skills"
        const val PREF_AI_ENV_NAMES = "one.ai.envNames"
        const val PREF_AI_ENV_VALUES = "one.ai.envValues"
    }
}
