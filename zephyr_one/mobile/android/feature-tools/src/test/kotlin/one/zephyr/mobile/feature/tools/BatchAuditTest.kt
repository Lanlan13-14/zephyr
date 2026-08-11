package one.zephyr.mobile.feature.tools

import java.security.MessageDigest
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BatchAuditTest {

    @Test
    fun commandDigestIsDomainSeparatedAndUsesUtf8ByteLength() {
        val command = "echo " + 0x4e2d.toChar()
        val record = BatchAudit.recordOf(state(command))

        assertEquals(command.toByteArray(Charsets.UTF_8).size, record.commandUtf8ByteLength)
        assertEquals(BatchAudit.commandDigest(command), record.commandDigest)
        assertNotEquals(sha256(command.toByteArray(Charsets.UTF_8)), record.commandDigest)
        assertTrue(record.commandDigest.matches(Regex("[0-9a-f]{64}")))
    }

    @Test
    fun auditRecordNeverCarriesUnlabelledTokensInlinePasswordsOrShellSecrets() {
        val bearerCanary = "UNLABELLED_BEARER_CANARY"
        val passwordCanary = "INLINE_PASSWORD_CANARY"
        val shellCanary = "SHELL_SECRET_CANARY"
        val command = "curl -H 'Authorization: Bearer $bearerCanary' --password=$passwordCanary; " +
            "export AWS_SECRET_ACCESS_KEY=$shellCanary"
        val record = BatchAudit.recordOf(
            state(
                command = command,
                error = MobileError.local(code = "remote-error-$shellCanary", message = command),
            ),
        )

        assertEquals(1, record.targetCount)
        assertEquals("unknown_error", record.results.single().errorCode)
        assertNoCommandText(record.toString(), bearerCanary, passwordCanary, shellCanary, command)
        val fieldNames = BatchAuditRecord::class.java.declaredFields.map { it.name }
        assertTrue(fieldNames.containsAll(listOf("commandDigest", "commandUtf8ByteLength", "targetCount", "results")))
        assertFalse(fieldNames.any { it == "command" || it.contains("preview", ignoreCase = true) })
    }

    @Test
    fun persistenceAndLogProjectionsCannotContainTheCommand() {
        val command = "printf '%s' ROOM_AND_LOG_SECRET_CANARY"
        val record = BatchAudit.recordOf(state(command))

        // These are the values a Room entity, wire serializer, or structured logger can receive.
        val persistenceProjection = listOf(
            record.commandDigest,
            record.commandUtf8ByteLength.toString(),
            record.targetCount.toString(),
            record.results.joinToString(),
        ).joinToString("|")
        val logProjection = "batch_audit digest=${record.commandDigest} bytes=${record.commandUtf8ByteLength} " +
            "targets=${record.targetCount} results=${record.results}"

        assertNoCommandText(persistenceProjection, command, "ROOM_AND_LOG_SECRET_CANARY")
        assertNoCommandText(logProjection, command, "ROOM_AND_LOG_SECRET_CANARY")
    }

    private fun state(command: String, error: MobileError? = null): BatchRunState = BatchRunState(
        plan = BatchPlan(command = command),
        targets = listOf(
            BatchTargetState(
                target = BatchTarget(
                    connectionId = "target-1",
                    name = "test target",
                    host = "example.invalid",
                    port = 22,
                    protocol = Protocol.SSH,
                    capabilities = CapabilitySet.owner,
                ),
                status = if (error == null) BatchTargetStatus.SUCCEEDED else BatchTargetStatus.FAILED,
                exitCode = if (error == null) 0 else null,
                error = error,
            ),
        ),
    )

    private fun assertNoCommandText(value: String, vararg forbidden: String) {
        forbidden.forEach { candidate -> assertFalse("Leaked $candidate in $value", value.contains(candidate)) }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
