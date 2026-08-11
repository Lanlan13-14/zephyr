package one.zephyr.mobile.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.security.ResidencyViolationException
import org.junit.Assert.assertThrows
import org.junit.Test

class ConflictPayloadValidatorTest {

    @Test
    fun `owned editable payload is accepted`() {
        ConflictPayloadValidator.requireSafe(
            entityType = "connection",
            payload = strings(
                "ownerUserId" to "user-1",
                "name" to "server name",
                "host" to "host.example",
            ),
            boundUserId = "user-1",
        )
    }

    @Test
    fun `dotted registry paths validate their nested shape`() {
        ConflictPayloadValidator.requireSafe(
            entityType = "oneUserSettings",
            payload = JsonObject(
                mapOf(
                    "userId" to JsonPrimitive("user-1"),
                    "appearance" to JsonObject(mapOf("theme" to JsonPrimitive("dark"))),
                ),
            ),
            boundUserId = "user-1",
        )
    }

    @Test
    fun `missing foreign and non-string owners fail closed`() {
        assertViolation { strings("name" to "missing") }
        assertViolation {
            strings(
                "ownerUserId" to "user-2",
                "name" to "foreign",
            )
        }
        assertViolation {
            JsonObject(
                mapOf(
                    "ownerUserId" to JsonPrimitive(7),
                    "name" to JsonPrimitive("wrong type"),
                ),
            )
        }
    }

    @Test
    fun `secret device-local server-authority and unknown fields are rejected`() {
        for (field in listOf("password", "ephemeral", "revision", "unknownField")) {
            assertViolation {
                strings(
                    "ownerUserId" to "user-1",
                    "name" to "safe",
                    field to "must not persist",
                )
            }
        }
    }

    @Test
    fun `nested secret aliases and canaries are rejected before conflict persistence`() {
        assertViolation {
            JsonObject(
                mapOf(
                    "ownerUserId" to JsonPrimitive("user-1"),
                    "rdpPipeline" to JsonObject(
                        mapOf(
                            "credentials" to JsonObject(
                                mapOf("private_key" to JsonPrimitive("raw-secret-canary")),
                            ),
                        ),
                    ),
                ),
            )
        }
    }

    @Test
    fun `server-only entity types are rejected`() {
        assertThrows(ResidencyViolationException::class.java) {
            ConflictPayloadValidator.requireSafe(
                entityType = "serverSettings",
                payload = strings(
                    "serverId" to "user-1",
                    "appearance" to "unsafe",
                ),
                boundUserId = "user-1",
            )
        }
    }

    @Test
    fun `unknown entity types are rejected`() {
        assertThrows(ResidencyViolationException::class.java) {
            ConflictPayloadValidator.requireSafe(
                entityType = "futureSharedEntity",
                payload = strings("ownerUserId" to "user-1"),
                boundUserId = "user-1",
            )
        }
    }

    @Test
    fun `deep structures are rejected before persistence`() {
        var nested: JsonElement = JsonPrimitive("leaf")
        repeat(ConflictPayloadValidator.MAX_DEPTH + 1) {
            nested = JsonObject(mapOf("child" to nested))
        }
        val payload = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "config" to nested,
            ),
        )

        assertThrows(ResidencyViolationException::class.java) {
            ConflictPayloadValidator.requireSafe("aiProvider", payload, "user-1")
        }
    }

    private fun assertViolation(payload: () -> JsonObject) {
        assertThrows(ResidencyViolationException::class.java) {
            ConflictPayloadValidator.requireSafe("connection", payload(), "user-1")
        }
    }

    private fun strings(vararg pairs: Pair<String, String>): JsonObject =
        JsonObject(pairs.associate { (key, value) -> key to JsonPrimitive(value) })
}
