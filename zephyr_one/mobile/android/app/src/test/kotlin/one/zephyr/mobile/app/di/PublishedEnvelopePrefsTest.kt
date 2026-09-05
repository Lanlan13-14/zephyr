package one.zephyr.mobile.app.di

import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.model.Base64Codec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PublishedEnvelopePrefsTest {

    @Test
    fun `serverId round-trips as a JSON object SettingsRepository can parse`() {
        val encoded = PublishedEnvelopePrefs.encodeServerId("srv-published")
        val parsed = EntityCodec.parse(encoded)
        assertEquals("srv-published", EntityCodec.string(parsed, "value"))
        assertEquals("srv-published", PublishedEnvelopePrefs.decodeServerId(encoded))
    }

    @Test
    fun `serverId still reads the pre56 crash-write bare string`() {
        assertEquals("srv-published", PublishedEnvelopePrefs.decodeServerId("srv-published"))
        assertEquals("", PublishedEnvelopePrefs.decodeServerId("{not-json"))
        assertEquals("", PublishedEnvelopePrefs.decodeServerId(""))
    }

    @Test
    fun `serverKey round-trips without a colon-split payload`() {
        val publicKey = byteArrayOf(1, 2, 3, 4, 5)
        val encoded = PublishedEnvelopePrefs.encodeServerKey(7, publicKey)
        val parsed = EntityCodec.parse(encoded)
        assertEquals(7, EntityCodec.intOrNull(parsed, "keyVersion"))
        val decoded = PublishedEnvelopePrefs.decodeServerKey(encoded)
        assertNotNull(decoded)
        assertEquals(7, decoded!!.first)
        assertArrayEquals(publicKey, decoded.second)
    }

    @Test
    fun `serverKey still reads the pre56 version-colon-base64 write`() {
        val publicKey = byteArrayOf(9, 8, 7)
        val legacy = "3:" + Base64Codec.encode(publicKey)
        val decoded = PublishedEnvelopePrefs.decodeServerKey(legacy)
        assertNotNull(decoded)
        assertEquals(3, decoded!!.first)
        assertArrayEquals(publicKey, decoded.second)
    }

    @Test
    fun `encoded rows are JSON objects so observePreferences cannot throw`() {
        val id = PublishedEnvelopePrefs.encodeServerId("srv-1")
        val key = PublishedEnvelopePrefs.encodeServerKey(1, byteArrayOf(1))
        assertTrue(id.startsWith("{"))
        assertTrue(key.startsWith("{"))
        EntityCodec.parse(id)
        EntityCodec.parse(key)
    }
}
