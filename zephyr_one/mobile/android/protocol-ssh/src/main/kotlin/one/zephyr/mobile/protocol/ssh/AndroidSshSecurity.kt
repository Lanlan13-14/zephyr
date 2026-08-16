package one.zephyr.mobile.protocol.ssh

import net.schmizz.sshj.common.SecurityUtils

/** Android must use platform JCE rather than SSHJ's reflected external BC provider. */
internal object AndroidSshSecurity {
    @Volatile private var configured = false

    fun configure() {
        if (configured) return
        synchronized(this) {
            if (configured) return
            // Android already ships a cut-down provider called "BC". Retaining and registering
            // org.bouncycastle.jce.provider.BouncyCastleProvider gives two providers the same name;
            // SSHJ can then resolve X25519/ECDSA against Android's incomplete instance and die in
            // client.connect() before password or public-key authentication starts.
            SecurityUtils.setSecurityProvider(null)
            SecurityUtils.setRegisterBouncyCastle(false)
            configured = true
        }
    }
}
