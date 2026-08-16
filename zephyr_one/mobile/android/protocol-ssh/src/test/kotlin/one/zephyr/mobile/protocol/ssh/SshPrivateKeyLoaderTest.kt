package one.zephyr.mobile.protocol.ssh

import net.schmizz.sshj.userauth.keyprovider.KeyFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SshPrivateKeyLoaderTest {

    @Test
    fun modernOpenSshEd25519IsOpenSshV1NotLegacyPem() {
        val parsed = SshPrivateKeyLoader.inspect(ED25519)
        assertEquals(KeyFormat.OpenSSHv1, parsed.format)
        assertFalse(parsed.encrypted)
        assertEquals(
            "OpenSSHKeyV1KeyFile",
            SshPrivateKeyLoader.providerFor(parsed.format).javaClass.simpleName,
        )
        val key = SshPrivateKeyLoader.load(ED25519, passphrase = null)
        assertEquals("EdDSA", key.`public`.algorithm)
        assertEquals("EdDSA", key.`private`.algorithm)
        assertEquals("none", SshPrivateKeyLoader.openSshV1CipherName(ED25519))
    }

    @Test
    fun wrappedPastedKeyStillLoads() {
        val wrapped = "请粘贴下面的内容\n\n$ED25519\n\n完"
        val parsed = SshPrivateKeyLoader.inspect(wrapped)
        assertEquals(KeyFormat.OpenSSHv1, parsed.format)
        assertTrue(parsed.pem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"))
        assertTrue(parsed.pem.endsWith("-----END OPENSSH PRIVATE KEY-----"))
        SshPrivateKeyLoader.load(wrapped, null)
    }

    @Test
    fun encryptedOpenSshKeyRequiresThePassphrase() {
        val parsed = SshPrivateKeyLoader.inspect(ED25519_ENCRYPTED)
        assertEquals(KeyFormat.OpenSSHv1, parsed.format)
        assertTrue(parsed.encrypted)
        assertEquals("aes256-ctr", SshPrivateKeyLoader.openSshV1CipherName(ED25519_ENCRYPTED))
        assertTrue(SshPrivateKeyLoader.isEncrypted(parsed.pem, parsed.format))
        assertFalse(ED25519_ENCRYPTED.contains("bcrypt"))
        try {
            SshPrivateKeyLoader.load(ED25519_ENCRYPTED, null)
            throw AssertionError("encrypted key accepted without passphrase")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("口令"))
        }
        try {
            SshPrivateKeyLoader.load(ED25519_ENCRYPTED, "wrong".toCharArray())
            throw AssertionError("wrong passphrase accepted")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("口令"))
        }
        val key = SshPrivateKeyLoader.load(ED25519_ENCRYPTED, "correct horse".toCharArray())
        assertEquals("EdDSA", key.`public`.algorithm)
    }

    @Test
    fun pkcs1RsaStillUsesThePemProvider() {
        val parsed = SshPrivateKeyLoader.inspect(RSA_PEM)
        assertEquals(KeyFormat.PKCS8, parsed.format)
        assertEquals("PKCS8KeyFile", SshPrivateKeyLoader.providerFor(parsed.format).javaClass.simpleName)
        val key = SshPrivateKeyLoader.load(RSA_PEM, null)
        assertEquals("RSA", key.`public`.algorithm)
        assertEquals("RSA", key.`private`.algorithm)
    }

    @Test
    fun garbageIsRejectedBeforeTalkingToAServer() {
        try {
            SshPrivateKeyLoader.load("not-a-key", null)
            throw AssertionError("garbage accepted")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("私钥"))
        }
    }

    @Test
    fun deletingTheV1BranchWouldSendModernKeysToTheLegacyParser() {
        val parsed = SshPrivateKeyLoader.inspect(ED25519)
        val wrong = net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile()
        wrong.init(parsed.pem, null, null)
        try {
            wrong.`private`
            throw AssertionError("legacy OpenSSH parser accepted a v1 key")
        } catch (_: Exception) {
            // The whole point of SshPrivateKeyLoader: this is what the old loadKey did.
        }
        val right = SshPrivateKeyLoader.providerFor(parsed.format)
        right.init(parsed.pem, null, null)
        assertEquals("EdDSA", right.`public`.algorithm)
    }

    private companion object {
        const val ED25519 = """
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDCNOa2VSpZOlSzO9Z8jXhGIJDyq02ESWICLwSdnUsotAAAAJDSAUTF0gFE
xQAAAAtzc2gtZWQyNTUxOQAAACDCNOa2VSpZOlSzO9Z8jXhGIJDyq02ESWICLwSdnUsotA
AAAEBRkilTYHsUxFV2w9xeaktHCWNOFQ6IWxPbDRy2rbh8/sI05rZVKlk6VLM71nyNeEYg
kPKrTYRJYgIvBJ2dSyi0AAAAC3plcGh5ci10ZXN0AQI=
-----END OPENSSH PRIVATE KEY-----
"""

        const val ED25519_ENCRYPTED = """
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDud1KCPl
RoyDsV2rlcmRtCAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAILl3rdVFSpxo7ra/
ZtL2W++WTixQz5hFrjH9t/GM8HbFAAAAkH5xkd0zNz+RvQLm4nEKwyexeV8+Toxm3mH6dY
/RL5vISS/XPWos4z8nj2hZZweFNlmkjQKkXZNa+J8ZAzVglznX4Zw5dG1zHzu2gIOZayK6
GjFy2yBnyNywu6QLUFlNnnZJHXbaHxDEFEbP0ktiI2VpqMDbhnUeosIurAhupnH7bgE9tU
n78gVxzDzsPMyhHA==
-----END OPENSSH PRIVATE KEY-----
"""

        const val RSA_PEM = """
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAra3cXUXWpS8OGmCQgaNmbi/L7Arx1T067ev2xPoTnye7Nh3v
9SSvkxxPLooe6yI0KlsHHBrd40l7JhGEsvhCoNopLHjRo19EhM0lwYX3xZDPX0xm
y8/GxNSCP9bFWFQdUymRW8k3G6m+sCTUoL4CSK48vRq6xaP0HenpwdNh/FcoXs4p
cjqOlzAyHuN8LWDKVfhbWdzYy816yLnMZvOkm8eQiw2OLdJpK2JQGogInfQ0Cd8q
Z2Oq/3qRcx1Jc6ApXGuVjvz4tKD1y9BYouB+bpeOqZBabnviDhtuDShkRxtKdZba
q8ZvA70maWB68/bEIWq1uftJKlkJklI1XuhmhQIDAQABAoIBAACN8wjsxfw8K/f+
RVBZEVR7BpWk2UJA0Cyrj3bwFPG+HX8b9+mO37PcaAAOKkfJN98eqVJXTwWeiBkO
donIKbjYzz9lUB4y5hdF8JF44QBPlGLC0p6kNw0CP3zNoCM+Oaz5/yr6XIArQgOI
FHFzMKgfmQH1zntxGI+TH081cuC42Wu8+2ZBaMsLunK9JcXFopQY/g5dhFxkWkKH
jh/tAzwag2E+i9xjzsWago99+KGrrgqKE/RakAq1q7+fNPyHbCPj/lSBTdJYP0rJ
plLMe7xzWUB3gwgI0PvGZt/BWxmys4DkchjlERjQegPkK+o+s8duzraNIFUtDnGq
fhiY80ECgYEA3e4HuSOqzVfG2ChvLIZWPua8OXjqNq9d4sKaTzRCGl230m1tXYF2
ClMHQH0CakPzqcm/rX22VgLTU9viB+b7xgoqu+gKw4+sYx7+noRCsppKsV7tqHk0
VNGDEAQ6FE8nLUCDPO1zbYqjJfd5cIOwZtktYHURhdlb+3rdDIFdEokCgYEAyFeN
O9+3ZPQdBP603rGAgovSkO/Jp72+Pw9okVtsBRoiE5br8e+Qk0Pp/CQHu2zVNfNW
slK8GlDUBynsx6AicygFl2ObLEExrBDT6G3BljSymQAvufVclvpkf4c3xPgXnBCJ
oe8/BfCXFh9Bm/gi4RmMmsdShy09JHsBCPhTpR0CgYEAyGZHjRO7CT+o68nfUfpg
aN5bux4HiKfkhH4rbzgGNN7JvfdYGWZs27fLxZzckG6Z2Yi3UAdDnflhMMlOGsqm
MVc+7X0EM0FKbhsv2p4dyD9xESdiPY5tBeZGjjDy7SHog4FMwLi+UX0uA3urqkEQ
Cl80DXTJBO+YksaIUuGB1NkCgYA0/rPlerBQjCKBB79giSOtZL82h7eYH6ELnU/T
45MXZmpNNEcFoJFl4zkp8X36HjfoJY5xbWFEtMzheD2iMMHsJFIWUcriUfyJv4nO
mfnzec0km+AEGNt9NI8RDPu7psTYC6fcpiTNtW7B81Kvp1vSn6eJ6d/y0gyycbc8
YDQAIQKBgQC1j1VuECJWHSL2/2/qRW/tppF+jQSyy5awq4wb0PrrkoReptuj0jJn
NoDbLJYEiLMHInbw9rkcDYxxEc1UcsIbZSCOr/8KYnMI/HsC6XqjAeQ45KwX7gbj
zcqdA0PFMknWOh7xH/PYZT5esVU13n8JGOePzHe+Ec18i/vUVm9RuA==
-----END RSA PRIVATE KEY-----
"""
    }
}
