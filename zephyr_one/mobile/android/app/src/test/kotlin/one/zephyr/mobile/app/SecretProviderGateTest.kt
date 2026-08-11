package one.zephyr.mobile.app

import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SecretProviderGateTest {

    @Test
    fun `false presence blocks even an explicit ref`() {
        assertNull(
            secretRefForPresence(
                SecretPresence(false, SecretRef.of("connection", "c-1", "password").value),
                "connection",
                "c-1",
                "password",
            ),
        )
    }

    @Test
    fun `present fields derive a canonical hostile-id ref`() {
        val expected = SecretRef.of("connection", "folder/child:2", "privateKey")

        assertEquals(
            expected,
            secretRefForPresence(
                SecretPresence(hasValue = true),
                "connection",
                "folder/child:2",
                "privateKey",
            ),
        )
    }

    @Test
    fun `an explicit ref cannot redirect a provider to another entity`() {
        assertNull(
            secretRefForPresence(
                SecretPresence(true, SecretRef.of("connection", "victim", "password").value),
                "connection",
                "requested",
                "password",
            ),
        )
    }
}
