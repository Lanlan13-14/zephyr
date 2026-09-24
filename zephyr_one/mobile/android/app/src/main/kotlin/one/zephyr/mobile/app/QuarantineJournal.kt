package one.zephyr.mobile.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persistent store for the AI entity sync quarantine (spec §5.2): a failed
 * entity must stay isolated across process restarts, or it re-enters the
 * sync plan after every relaunch and keeps failing while blocking nothing
 * but reappearing as a fresh conflict. The journal is written on every
 * quarantine mutation and read once at coordinator start.
 */
internal class QuarantineJournal(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("ai_entity_quarantine", Context.MODE_PRIVATE)

    fun load(): Map<String, QuarantineItem> {
        val raw = prefs.getString(KEY_ITEMS, null) ?: return emptyMap()
        return try {
            val arr = JSONArray(raw)
            val out = LinkedHashMap<String, QuarantineItem>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val item = QuarantineItem(
                    entityType = obj.getString("entityType"),
                    entityId = obj.getString("entityId"),
                    reason = obj.optString("reason", ""),
                    quarantinedAt = obj.optLong("quarantinedAt", 0L),
                    retryCount = obj.optInt("retryCount", 0),
                )
                out["${item.entityType}:${item.entityId}"] = item
            }
            out
        } catch (_: Throwable) {
            emptyMap()
        }
    }

    fun save(items: Collection<QuarantineItem>) {
        val arr = JSONArray()
        for (item in items) {
            arr.put(
                JSONObject()
                    .put("entityType", item.entityType)
                    .put("entityId", item.entityId)
                    .put("reason", item.reason)
                    .put("quarantinedAt", item.quarantinedAt)
                    .put("retryCount", item.retryCount),
            )
        }
        prefs.edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    private companion object {
        const val KEY_ITEMS = "items"
    }
}