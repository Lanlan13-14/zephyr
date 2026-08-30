package one.zephyr.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileErrorDiagnosticsTest {

    @Test
    fun `remote error message is never persisted`() {
        val secret = "https://private.example/users/alice?token=secret"
        val error = MobileError(
            code = "malformed_response",
            message = secret,
            retryable = false,
            requestId = "request-1",
            httpStatus = 200,
        )

        val persisted = error.persistedDiagnosticText()

        assertEquals("code=malformed_response status=200 requestId=request-1", persisted)
        assertFalse(persisted.contains(secret))
    }

    @Test
    fun `explicit client local diagnostic is bounded and persisted`() {
        val error = MobileError.local("malformed_response", "display only")
            .copy(requestId = "request-2")
            .withLocalDiagnostic("sync.bootstrap map: sync change has an invalid changedAt")

        val persisted = error.persistedDiagnosticText()

        assertTrue(persisted.startsWith("sync.bootstrap map: sync change has an invalid changedAt · "))
        assertTrue(persisted.endsWith("code=malformed_response requestId=request-2"))
    }

    @Test
    fun `line breaks cannot inject additional diagnostic lines`() {
        val error = MobileError.local("malformed_response", "display only")
            .withLocalDiagnostic("sync.push map: invalid receipt\nsecret=must-not-appear")

        val persisted = error.persistedDiagnosticText()

        assertEquals("sync.push map: invalid receipt · code=malformed_response", persisted)
        assertFalse(persisted.contains("must-not-appear"))
    }
}
