package one.zephyr.mobile.app

import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test
    fun `an empty create-password field is not a replacement secret`() {
        assertNull(null.takeUnlessBlankSecret())
        val empty = CharArray(0)
        assertNull(empty.takeUnlessBlankSecret())
        val spaces = charArrayOf(' ', '\t')
        assertNull(spaces.takeUnlessBlankSecret())
        assertTrue(spaces.all { it.code == 0 })
        val typed = charArrayOf('s', 'e', 'c', 'r', 'e', 't')
        assertEquals("secret", typed.takeUnlessBlankSecret()?.concatToString())
    }

    @Test
    fun `blank replacement password must not hide a stored ssh key`() {
        val replacementPassword = "".toCharArray()
        val storedKey = "-----BEGIN OPENSSH PRIVATE KEY-----".toCharArray()
        val password = replacementPassword.takeUnlessBlankSecret()
        val key = storedKey.takeUnlessBlankSecret()
        assertNull(password)
        assertEquals("-----BEGIN OPENSSH PRIVATE KEY-----", key?.concatToString())
    }
}
