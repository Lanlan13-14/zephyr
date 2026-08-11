package one.zephyr.mobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

class SyncSchedulerIdentityTest {

    @Test
    fun `work scope survives process recreation for the same binding generation`() {
        val first = SyncScheduler.scopeId("server/user/device", "4:1000")
        val recreated = SyncScheduler.scopeId("server/user/device", "4:1000")

        assertEquals(first, recreated)
        assertEquals(24, first.length)
        assertFalse(first.contains("server"))
    }

    @Test
    fun `new bind generation cannot collide with old unique work`() {
        val old = SyncScheduler.scopeId("server/user/device", "4:1000")
        val rebound = SyncScheduler.scopeId("server/user/device", "4:2000")
        val switched = SyncScheduler.scopeId("server/other/device", "4:1000")

        assertNotEquals(old, rebound)
        assertNotEquals(old, switched)
    }
}
