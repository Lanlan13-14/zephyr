package one.zephyr.mobile.feature.notes

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** How a file came to be in the recent list. Only these two are user-initiated. */
enum class RecentFileOrigin { BROWSED, DOWNLOADED }

/**
 * One row of 最近文件.
 *
 * SCREEN_CATALOG.md 11 allows this list to hold only metadata for files the user *actively* browsed
 * or downloaded, so there is no field here that could be filled by a background scan: every record
 * is created from a tap.
 */
data class RecentFileRecord(
    val connectionId: String,
    val connectionLabel: String,
    val path: String,
    val name: String,
    val sizeBytes: Long,
    val mtimeMs: Long,
    val touchedAt: Long,
    val origin: RecentFileOrigin,
) {

    /**
     * The projection that is allowed to leave the device.
     *
     * SCREEN_CATALOG.md 11 says the path must not enter telemetry by default, and SCREEN_CATALOG.md 2
     * bans host/user/path from diagnostics. Returning a map with no path and no connection label
     * makes that rule enforceable by a test rather than by reviewer discipline: anything that ships
     * a recent file to an analytics or diagnostics sink must call this, and it structurally cannot
     * carry the sensitive parts.
     */
    fun telemetrySafeFields(): Map<String, String> = mapOf(
        "origin" to origin.name.lowercase(),
        "extension" to RemotePath.extensionOf(path),
        "sizeBucket" to sizeBucket(sizeBytes),
    )

    private fun sizeBucket(bytes: Long): String = when {
        bytes < 64 * 1024 -> "lt64k"
        bytes < 1024 * 1024 -> "lt1m"
        bytes < 64L * 1024 * 1024 -> "lt64m"
        else -> "gte64m"
    }
}

/**
 * Device-local recent-file metadata.
 *
 * A per-device preference rather than account data: the frozen entity registry publishes no
 * "recent file" entity, so pushing one would be inventing a contract. Stored through
 * SettingsRepository's preference table, which never enters a fieldMask.
 */
object RecentResourceFiles {

    const val PREFERENCE_KEY = "one.resources.recentFiles"

    /** Deliberately small: this is a convenience strip, not a history feature. */
    const val MAX_RECORDS = 20

    /**
     * Newest first, de-duplicated by connection+path.
     *
     * Re-opening a file moves it to the front instead of adding a second row, because a list with
     * the same file four times tells the user nothing.
     */
    fun touched(existing: List<RecentFileRecord>, record: RecentFileRecord): List<RecentFileRecord> {
        val withoutSame = existing.filterNot {
            it.connectionId == record.connectionId && it.path == record.path
        }
        return (listOf(record) + withoutSame).sortedByDescending { it.touchedAt }.take(MAX_RECORDS)
    }

    fun removedForConnection(existing: List<RecentFileRecord>, connectionId: String): List<RecentFileRecord> =
        existing.filterNot { it.connectionId == connectionId }

    fun cleared(): List<RecentFileRecord> = emptyList()

    fun decode(value: JsonObject?): List<RecentFileRecord> {
        val rows = value?.get("files") ?: return emptyList()
        return runCatching {
            rows.jsonArray.mapNotNull { element ->
                val row = element.jsonObject
                val path = row["path"]?.jsonPrimitive?.content ?: return@mapNotNull null
                val connectionId = row["connectionId"]?.jsonPrimitive?.content ?: return@mapNotNull null
                RecentFileRecord(
                    connectionId = connectionId,
                    connectionLabel = row["connectionLabel"]?.jsonPrimitive?.content ?: "",
                    path = path,
                    name = row["name"]?.jsonPrimitive?.content ?: RemotePath.nameOf(path),
                    sizeBytes = row["sizeBytes"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    mtimeMs = row["mtimeMs"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    touchedAt = row["touchedAt"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    // An unreadable origin falls back to BROWSED rather than dropping the row: the
                    // weaker claim is the safe one, because DOWNLOADED asserts a local copy exists.
                    origin = runCatching {
                        RecentFileOrigin.valueOf(row["origin"]?.jsonPrimitive?.content ?: "")
                    }.getOrDefault(RecentFileOrigin.BROWSED),
                )
            }
        }.getOrDefault(emptyList())
    }

    fun encode(records: List<RecentFileRecord>): JsonObject = JsonObject(
        mapOf(
            "files" to JsonArray(
                records.take(MAX_RECORDS).map { record ->
                    JsonObject(
                        mapOf(
                            "connectionId" to JsonPrimitive(record.connectionId),
                            "connectionLabel" to JsonPrimitive(record.connectionLabel),
                            "path" to JsonPrimitive(record.path),
                            "name" to JsonPrimitive(record.name),
                            "sizeBytes" to JsonPrimitive(record.sizeBytes),
                            "mtimeMs" to JsonPrimitive(record.mtimeMs),
                            "touchedAt" to JsonPrimitive(record.touchedAt),
                            "origin" to JsonPrimitive(record.origin.name),
                        ),
                    )
                },
            ),
        ),
    )
}
