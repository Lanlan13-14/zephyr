package one.zephyr.mobile.model.sync

import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.contracts.SyncEntitySpec

/** Why a requested field was dropped from a mask. */
enum class MaskRejectionReason { FORBIDDEN, UNKNOWN, DUPLICATE;
    val wireName: String get() = name.lowercase()
}

data class MaskRejection(val field: String, val reason: MaskRejectionReason)

data class SanitizedMask(
    val accepted: List<String>,
    val rejected: List<MaskRejection>,
) {
    val hasRejections: Boolean get() = rejected.isNotEmpty()
}

/**
 * fieldMask sanitation.
 *
 * SYNC_STATE_MACHINE.md 4.3 and DATA_AND_MIGRATION.md 3.2: a mask may only name editable fields the
 * user actually changed. Secret, serverAuthority, opaquePreserve, deviceLocal and unknown fields are
 * always dropped, which is what stops a masked placeholder ("******") from being pushed as if it
 * were a new secret. This is the last line of defence, so it runs on every write regardless of what
 * the UI believes it collected.
 */
object FieldMask {

    fun spec(entityType: String): SyncEntitySpec =
        EntityRegistry.byType[entityType]
            ?: throw IllegalArgumentException("unknown_entity_type: " + entityType)

    /**
     * Nested paths are checked at their root: "tags[0]" and "appearance.theme" are permitted only
     * when "tags" / "appearance" (or the exact path) is editable. Server settings use dotted
     * section keys, so the exact-match branch matters.
     */
    fun rootOf(field: String): String {
        var cut = field.length
        for (index in field.indices) {
            val ch = field[index]
            if (ch == '.' || ch == '[') { cut = index; break }
        }
        return field.substring(0, cut)
    }

    fun sanitize(entityType: String, requested: List<String>): SanitizedMask {
        val meta = spec(entityType)
        val editable = meta.editableFields.toSet()
        val forbidden = meta.forbiddenMaskFields.toSet()
        val accepted = mutableListOf<String>()
        val rejected = mutableListOf<MaskRejection>()
        for (field in requested) {
            val root = rootOf(field)
            when {
                forbidden.contains(root) || forbidden.contains(field) ->
                    rejected.add(MaskRejection(field, MaskRejectionReason.FORBIDDEN))
                !editable.contains(root) && !editable.contains(field) ->
                    rejected.add(MaskRejection(field, MaskRejectionReason.UNKNOWN))
                accepted.contains(field) ->
                    rejected.add(MaskRejection(field, MaskRejectionReason.DUPLICATE))
                else -> accepted.add(field)
            }
        }
        return SanitizedMask(accepted, rejected)
    }
}
