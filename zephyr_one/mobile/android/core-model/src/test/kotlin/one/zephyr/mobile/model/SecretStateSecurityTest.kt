package one.zephyr.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecretStateSecurityTest {

    @Test
    fun `utf8 import has independent wipeable ownership and rejects malformed input`() {
        val bytes = "凭据-🔑".toByteArray(Charsets.UTF_8)
        val imported = SecretState.Replace.fromUtf8(bytes)
        bytes.fill(0)
        assertEquals("凭据-🔑", imported.editingText())
        assertFalse(imported.toString().contains("凭据"))
        imported.wipe()
        assertTrue(imported.isWiped())
        org.junit.Assert.assertThrows(java.nio.charset.CharacterCodingException::class.java) {
            SecretState.Replace.fromUtf8(byteArrayOf(0xc3.toByte(), 0x28))
        }
    }

    @Test
    fun `replacement is redacted and wipeable`() {
        val secret = SecretState.Replace("do-not-log-this")

        assertFalse(secret.toString().contains("do-not-log-this"))
        assertEquals("do-not-log-this", secret.editingText())

        secret.wipe()
        assertTrue(secret.isWiped())
        assertFalse(secret.editingText().contains("do-not-log-this"))
    }

    @Test
    fun `utf8 handoff clears its temporary byte buffer`() {
        val secret = SecretState.Replace("password")
        lateinit var handedOff: ByteArray

        secret.withUtf8Bytes { bytes ->
            handedOff = bytes
            assertEquals("password", String(bytes, Charsets.UTF_8))
        }

        assertTrue(handedOff.all { it == 0.toByte() })
    }

    @Test
    fun `secret refs round trip hostile ids without delimiter collisions`() {
        val parent = SecretRef.of("connection", "abc", "password")
        val child = SecretRef.of("connection", "abc/child:2", "password/value")

        assertEquals(SecretRefParts("connection", "abc", "password"), parent.partsOrNull())
        assertEquals(
            SecretRefParts("connection", "abc/child:2", "password/value"),
            child.partsOrNull(),
        )
        assertTrue(parent.belongsTo("connection", "abc"))
        assertFalse(child.belongsTo("connection", "abc"))
        assertFalse(parent.value.startsWith("connection/abc/"))
    }

    @Test
    fun `legacy refs preserve slash containing entity ids during canonical migration`() {
        val legacy = SecretRef("connection/abc/child/password")
        val canonical = legacy.canonical()

        assertEquals(
            SecretRefParts("connection", "abc/child", "password"),
            legacy.partsOrNull(),
        )
        assertEquals(legacy.partsOrNull(), canonical.partsOrNull())
        assertEquals("connection/abc/child/password", canonical.legacyValueOrNull())
    }

    @Test
    fun `malformed structured refs never fall back to delimiter parsing`() {
        assertEquals(null, SecretRef("v2:10:short/legacy/value").partsOrNull())
        assertEquals(null, SecretRef("v2:1:a1:b1:cjunk").partsOrNull())
    }
}
