package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.SecretState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResourceDraftsTest {

    @Test
    fun `new proxy cannot save until name and host exist`() {
        val blank = ProxyDraft.create("u", "p1")
        assertFalse(blank.canSave)
        assertEquals(ResourceDrafts.MSG_NAME_REQUIRED, blank.validate().first().message)

        val named = blank.withName("edge").withHost("10.0.0.1")
        assertTrue(named.canSave)
        assertTrue(named.isCreate)
        assertEquals(ProxyDraft.FIELDS, named.changedFields())
    }

    @Test
    fun `new ssh key cannot save without private key material`() {
        val blank = SshKeyDraft.create("u", "k1").withName("laptop")
        assertFalse(blank.canSave)
        assertEquals(SshKeyDraft.MSG_KEY_REQUIRED, blank.validate().single().message)

        val withKey = blank.withPrivateKey(SecretState.Replace("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"))
        assertTrue(withKey.canSave)
        assertTrue(withKey.privateKey.contributesToFieldMask)
    }

    @Test
    fun `blank private key folds to clear instead of an empty secret`() {
        val draft = SshKeyDraft.create("u", "k1").withPrivateKey(SecretState.Replace("   "))
        assertEquals(SecretState.Clear, draft.privateKey)
    }
}
