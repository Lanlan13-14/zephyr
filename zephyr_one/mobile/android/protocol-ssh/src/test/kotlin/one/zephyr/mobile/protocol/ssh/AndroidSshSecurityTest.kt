package one.zephyr.mobile.protocol.ssh

import net.schmizz.sshj.common.SecurityUtils
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidSshSecurityTest {

    @Test
    fun configuringTwiceKeepsSshjOnTheDefaultJceProvider() {
        AndroidSshSecurity.configure()
        AndroidSshSecurity.configure()

        assertNull(SecurityUtils.getSecurityProvider())
        assertFalse(SecurityUtils.isBouncyCastleRegistered())
    }
}
