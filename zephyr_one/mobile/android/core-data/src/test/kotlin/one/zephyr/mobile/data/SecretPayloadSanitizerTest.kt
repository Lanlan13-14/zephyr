package one.zephyr.mobile.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.SyncChange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Test

class SecretPayloadSanitizerTest {

    @Test
    fun `root presence and envelope-only payload is accepted`() {
        val payload = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "name" to JsonPrimitive("host"),
                "hasPassword" to JsonPrimitive(true),
                "hasPrivateKey" to JsonPrimitive(false),
            ),
        )

        assertSame(payload, SecretPayloadSanitizer.requireSafe("connection", payload))
    }

    @Test
    fun `sqlite integer presence is accepted and stored as a JSON boolean`() {
        val payload = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "name" to JsonPrimitive("host"),
                "hasPassword" to JsonPrimitive(1),
                "hasPrivateKey" to JsonPrimitive(0),
                "rdpClipboard" to JsonPrimitive(1),
            ),
        )

        val sanitized = SecretPayloadSanitizer.sanitizeForStorage("connection", payload)
        assertEquals(JsonPrimitive(true), sanitized["hasPassword"])
        assertEquals(JsonPrimitive(false), sanitized["hasPrivateKey"])
        assertEquals(true, EntityCodec.booleanOrNull(payload.getValue("hasPassword")))
        assertEquals(false, EntityCodec.booleanOrNull(payload.getValue("hasPrivateKey")))
        assertEquals(true, EntityCodec.bool(payload, "rdpClipboard", false))
    }

    @Test
    fun `registry secrets and normalized aliases are rejected without echoing canary`() {
        val aliases = listOf(
            "password" to "connection",
            "private_key" to "connection",
            "api-key" to "aiProvider",
            "token" to "clientToken",
            "access_token" to "connection",
            "clientSecret" to "connection",
        )
        for ((alias, entityType) in aliases) {
            val error = expectViolation(
                entityType = entityType,
                payload = JsonObject(mapOf(alias to JsonPrimitive(CANARY))),
            )
            assertEquals(SecretPayloadFailure.RAW_SECRET_FIELD, error.failure)
            assertFalse(error.message.orEmpty().contains(alias))
            assertFalse(error.message.orEmpty().contains(CANARY))
        }
    }

    @Test
    fun `nested aliases inside arrays cannot bypass the residency boundary`() {
        val payload = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "config" to JsonArray(
                    listOf(
                        JsonObject(
                            mapOf(
                                "credentials" to JsonObject(
                                    mapOf("PRIVATE-KEY" to JsonPrimitive(CANARY)),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals(
            SecretPayloadFailure.RAW_SECRET_FIELD,
            expectViolation("aiProvider", payload).failure,
        )
    }

    @Test
    fun `legacy raw values are stripped before a stored row is rewritten`() {
        val legacy = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "password" to JsonPrimitive(CANARY),
                "config" to JsonObject(
                    mapOf(
                        "nested_credentials" to JsonObject(
                            mapOf("access-token" to JsonPrimitive(CANARY)),
                        ),
                        "safe" to JsonPrimitive("kept"),
                    ),
                ),
                "hasPassword" to JsonPrimitive(true),
                "hasPrivateKey" to JsonPrimitive(false),
            ),
        )

        val sanitized = SecretPayloadSanitizer.sanitizeForStorage("connection", legacy)

        assertFalse(sanitized.toString().contains(CANARY))
        assertEquals(JsonPrimitive("kept"), (sanitized["config"] as JsonObject)["safe"])
        assertEquals(JsonPrimitive(true), sanitized["hasPassword"])
    }

    @Test
    fun `presence aliases nested presence and non booleans are rejected`() {
        val payloads = listOf(
            JsonObject(mapOf("has_password" to JsonPrimitive(true))),
            JsonObject(mapOf("nested" to JsonObject(mapOf("hasPassword" to JsonPrimitive(true))))),
            JsonObject(mapOf("hasPassword" to JsonPrimitive(CANARY))),
        )

        for (payload in payloads) {
            assertEquals(
                SecretPayloadFailure.INVALID_PRESENCE,
                expectViolation("connection", payload).failure,
            )
        }
    }

    @Test
    fun `local ai provider config rejects nested token before it is projected`() {
        val error = expectViolation {
            SecretPayloadSanitizer.sanitizeLocalEditableValues(
                entityType = "aiProvider",
                values = JsonObject(
                    mapOf(
                        "config" to JsonObject(
                            mapOf("transport" to JsonObject(mapOf("tokenValue" to JsonPrimitive(CANARY)))),
                        ),
                    ),
                ),
                acceptedMask = listOf("config"),
            )
        }

        assertEquals(SecretPayloadFailure.RAW_SECRET_FIELD, error.failure)
    }

    @Test
    fun `local editable values reject unknown unicode secret aliases and forged presence`() {
        val hostileKeys = listOf(
            "unknownSecretMaterial" to SecretPayloadFailure.RAW_SECRET_FIELD,
            "\uFF30\uFF32\uFF29\uFF36\uFF21\uFF34\uFF25\uFF3F\uFF2B\uFF25\uFF39" to SecretPayloadFailure.RAW_SECRET_FIELD,
            "hasPassword" to SecretPayloadFailure.INVALID_PRESENCE,
            "deviceEnvelope" to SecretPayloadFailure.RAW_SECRET_FIELD,
        )
        for ((key, expectedFailure) in hostileKeys) {
            val error = expectViolation(key) {
                SecretPayloadSanitizer.sanitizeLocalEditableValues(
                    entityType = "connection",
                    values = JsonObject(mapOf("protocol" to JsonObject(mapOf(key to JsonPrimitive(CANARY)))),),
                    acceptedMask = listOf("protocol"),
                )
            }
            assertEquals(key, expectedFailure, error.failure)
        }
    }

    @Test
    fun `local projection deep copies only exact editable paths`() {
        val suppliedProtocol = JsonObject(
            mapOf(
                "name" to JsonPrimitive("ssh"),
                "options" to JsonArray(listOf(JsonPrimitive("strict"))),
            ),
        )
        val values = JsonObject(
            mapOf(
                "protocol" to suppliedProtocol,
                "ownerUserId" to JsonPrimitive("attempted-authority-overwrite"),
                "host" to JsonPrimitive("not-masked"),
            ),
        )

        val sanitized = SecretPayloadSanitizer.sanitizeLocalEditableValues(
            entityType = "connection",
            values = values,
            acceptedMask = listOf("protocol"),
        )

        assertEquals(setOf("protocol"), sanitized.keys)
        assertEquals(suppliedProtocol, sanitized["protocol"])
        assertNotSame(suppliedProtocol, sanitized["protocol"])
    }

    @Test
    fun `local projection rejects paths that are not exact registry editable fields`() {
        val error = expectViolation {
            SecretPayloadSanitizer.sanitizeLocalEditableValues(
                entityType = "connection",
                values = JsonObject(mapOf("protocol" to JsonPrimitive("ssh"))),
                acceptedMask = listOf("protocol.injected"),
            )
        }

        assertEquals(SecretPayloadFailure.INVALID_EDITABLE_PATH, error.failure)
    }

    @Test
    fun `exact nested settings edit preserves unmasked siblings`() {
        val local = SecretPayloadSanitizer.sanitizeLocalEditableValues(
            entityType = "oneUserSettings",
            values = JsonObject(
                mapOf(
                    "appearance" to JsonObject(
                        mapOf(
                            "theme" to JsonPrimitive("dark"),
                            "customCss" to JsonPrimitive("must-not-be-projected"),
                        ),
                    ),
                ),
            ),
            acceptedMask = listOf("appearance.theme"),
        )
        val merged = SecretPayloadSanitizer.mergeLocalEditableValues(
            entityType = "oneUserSettings",
            stored = JsonObject(
                mapOf(
                    "appearance" to JsonObject(
                        mapOf("theme" to JsonPrimitive("light"), "colorScheme" to JsonPrimitive("system")),
                    ),
                ),
            ),
            editableValues = local,
            acceptedMask = listOf("appearance.theme"),
        )

        assertNull((local["appearance"] as JsonObject)["customCss"])
        assertEquals(JsonPrimitive("dark"), ((merged["appearance"] as JsonObject)["theme"]))
        assertEquals(JsonPrimitive("system"), ((merged["appearance"] as JsonObject)["colorScheme"]))
    }

    @Test
    fun `oversized payload is rejected before it can become a Room string`() {
        val payload = JsonObject(
            mapOf("name" to JsonPrimitive("x".repeat(SecretPayloadSanitizer.MAX_BYTES))),
        )

        assertEquals(
            SecretPayloadFailure.PAYLOAD_TOO_LARGE,
            expectViolation("connection", payload).failure,
        )
    }

    @Test
    fun `overdeep payload is rejected`() {
        var nested: JsonElement = JsonPrimitive("leaf")
        repeat(SecretPayloadSanitizer.MAX_DEPTH + 1) {
            nested = JsonObject(mapOf("child" to nested))
        }

        assertEquals(
            SecretPayloadFailure.PAYLOAD_TOO_DEEP,
            expectViolation("aiProvider", JsonObject(mapOf("config" to nested))).failure,
        )
    }

    @Test
    fun `canonical ai provider downlink with option numbers is accepted`() {
        val payload = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "name" to JsonPrimitive("openai"),
                "type" to JsonPrimitive("openai-compatible"),
                "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                "defaultModel" to JsonPrimitive("gpt-4o"),
                "enabled" to JsonPrimitive(true),
                "hasApiKey" to JsonPrimitive(true),
                "config" to JsonObject(
                    mapOf(
                        "apiMode" to JsonPrimitive("auto"),
                        "options" to JsonObject(
                            mapOf(
                                "temperature" to JsonPrimitive(0.7),
                                "top_p" to JsonPrimitive(1.0),
                                "max_tokens" to JsonPrimitive(4096),
                                "max_output_tokens" to JsonPrimitive(8192),
                                "presence_penalty" to JsonPrimitive(0.0),
                                "frequency_penalty" to JsonPrimitive(0.0),
                            ),
                        ),
                    ),
                ),
                "models" to JsonArray(
                    listOf(
                        JsonObject(
                            mapOf(
                                "id" to JsonPrimitive("gpt-4o"),
                                "label" to JsonPrimitive("GPT-4o"),
                                "contextWindowTokens" to JsonPrimitive(128000),
                                "maxOutputTokens" to JsonPrimitive(16384),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertSame(payload, SecretPayloadSanitizer.requireSafe("aiProvider", payload))
        requireSafeInboundChanges(
            listOf(
                SyncChange(
                    changeSeq = 1,
                    entityType = "aiProvider",
                    entityId = "prov-1",
                    action = SyncAction.UPSERT,
                    revision = 3,
                    changedAt = 4,
                    payload = payload,
                ),
            ),
        )
    }

    @Test
    fun `local ai provider writes still cannot forge hasApiKey`() {
        val error = expectViolation {
            SecretPayloadSanitizer.sanitizeLocalEditableValues(
                entityType = "aiProvider",
                values = JsonObject(mapOf("hasApiKey" to JsonPrimitive(true), "name" to JsonPrimitive("x"))),
                acceptedMask = listOf("name"),
            )
        }
        assertEquals(SecretPayloadFailure.RAW_SECRET_FIELD, error.failure)
    }

    @Test
    fun `ai knowledge and history payloads without secrets are accepted`() {
        val memory = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "title" to JsonPrimitive("prod host"),
                "content" to JsonPrimitive("ssh as deploy"),
                "scope" to JsonPrimitive("global"),
            ),
        )
        val env = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "name" to JsonPrimitive("OPENAI_BASE"),
                "enabled" to JsonPrimitive(true),
                "visibleToAi" to JsonPrimitive(true),
                "hasValue" to JsonPrimitive(true),
            ),
        )
        val conversation = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "title" to JsonPrimitive("deploy"),
                "providerId" to JsonPrimitive("prov-1"),
                "model" to JsonPrimitive("gpt-4o"),
                "archived" to JsonPrimitive(false),
            ),
        )
        assertSame(memory, SecretPayloadSanitizer.requireSafe("aiMemory", memory))
        assertSame(env, SecretPayloadSanitizer.requireSafe("aiEnv", env))
        assertSame(conversation, SecretPayloadSanitizer.requireSafe("aiConversation", conversation))
    }

    @Test
    fun `delete tombstone is subject to the same raw secret scan`() {
        val change = SyncChange(
            changeSeq = 1,
            entityType = "connection",
            entityId = "connection-1",
            action = SyncAction.DELETE,
            revision = 2,
            changedAt = 3,
            tombstone = JsonObject(
                mapOf(
                    "ownerUserId" to JsonPrimitive("user-1"),
                    "password" to JsonPrimitive(CANARY),
                ),
            ),
        )

        val error = try {
            requireSafeInboundChanges(listOf(change))
            fail("expected SecretPayloadViolationException")
            error("unreachable")
        } catch (failure: SecretPayloadViolationException) {
            failure
        }
        assertEquals(SecretPayloadFailure.RAW_SECRET_FIELD, error.failure)
    }

    private fun expectViolation(entityType: String, payload: JsonObject): SecretPayloadViolationException =
        try {
            SecretPayloadSanitizer.requireSafe(entityType, payload)
            fail("expected SecretPayloadViolationException")
            error("unreachable")
        } catch (failure: SecretPayloadViolationException) {
            failure
        }

    private fun expectViolation(block: () -> Unit): SecretPayloadViolationException =
        expectViolation("payload", block)

    private fun expectViolation(label: String, block: () -> Unit): SecretPayloadViolationException =
        try {
            block()
            fail("expected SecretPayloadViolationException for " + label)
            error("unreachable")
        } catch (failure: SecretPayloadViolationException) {
            failure
        }

    private companion object {
        const val CANARY = "raw-secret-canary-never-persist"
    }
}
