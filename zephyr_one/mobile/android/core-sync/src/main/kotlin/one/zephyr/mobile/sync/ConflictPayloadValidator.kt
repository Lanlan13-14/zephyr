package one.zephyr.mobile.sync

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.data.SecretPayloadSanitizer
import one.zephyr.mobile.data.SecretPayloadViolationException
import one.zephyr.mobile.security.ResidencyViolationException

/** Validates the untrusted server view before a conflict can become durable account data. */
internal object ConflictPayloadValidator {

    const val MAX_BYTES: Int = SecretPayloadSanitizer.MAX_BYTES
    const val MAX_DEPTH: Int = SecretPayloadSanitizer.MAX_DEPTH

    fun requireSafe(entityType: String, payload: JsonObject, boundUserId: String) {
        if (boundUserId.isBlank()) fail("conflict store has no bound account owner")

        val spec = EntityRegistry.byType[entityType]
            ?: fail("conflict names an unknown entity type")
        if (spec.ownerField == "serverId" || spec.editableFields.isEmpty()) {
            fail("conflict names a server-only entity type")
        }
        try {
            SecretPayloadSanitizer.requireSafe(entityType, payload)
        } catch (_: SecretPayloadViolationException) {
            fail("conflict payload violates secret residency")
        }

        val owner = (payload[spec.ownerField] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.takeIf { it.isNotBlank() }
            ?: fail("conflict is missing a typed account owner")
        if (owner != boundUserId) fail("conflict belongs to a foreign or shared owner")

        val allowed = (spec.editableFields + spec.opaquePreserveFields).toSet()
        val forbidden = (
            spec.secretFields +
                spec.deviceLocalFields +
                spec.serverAuthorityFields.filterNot { it == spec.ownerField }
            ).toSet()

        for ((field, value) in payload) {
            validateField(
                path = field,
                value = value,
                ownerField = spec.ownerField,
                allowed = allowed,
                forbidden = forbidden,
            )
        }
    }

    private fun validateField(
        path: String,
        value: JsonElement,
        ownerField: String,
        allowed: Set<String>,
        forbidden: Set<String>,
    ) {
        if (path == ownerField) return
        if (forbidden.any { field -> path == field || path.startsWith("$field.") }) {
            fail("conflict payload contains a non-resident field")
        }
        if (allowed.any { field -> path == field || path.startsWith("$field.") }) return

        val hasAllowedDescendant = allowed.any { field -> field.startsWith("$path.") }
        if (!hasAllowedDescendant) fail("conflict payload contains an unknown field")
        val nested = value as? JsonObject
            ?: fail("conflict payload has an invalid nested field shape")
        for ((field, child) in nested) {
            validateField(
                path = "$path.$field",
                value = child,
                ownerField = ownerField,
                allowed = allowed,
                forbidden = forbidden,
            )
        }
    }

    private fun fail(message: String): Nothing = throw ResidencyViolationException(message)
}
